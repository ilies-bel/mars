import { WebSocketServer, type WebSocket } from 'ws';
import { getClient } from '../core/queue.js';
import { isEventName, type EventName } from './events.js';
import { log } from './log.js';

/**
 * Configuration for {@link startDaemon}.
 */
export interface DaemonOptions {
  /** WebSocket port. Defaults to BUS_PORT or 7777. */
  port?: number;
  /** If true, deliver every historical event to clients. Default: cursor = MAX(id). */
  fromStart?: boolean;
  /** Poll interval in ms. Default: 50. */
  pollIntervalMs?: number;
  /** Max events fetched per poll. Default: 500. */
  batchSize?: number;
}

/**
 * Per-connection bookkeeping. We track which event types the client has
 * subscribed to. `'*'` means deliver everything.
 */
interface ClientState {
  ws: WebSocket;
  topics: Set<string>; // set of EventName | '*'
}

interface RawEventRow {
  id: number;
  type: string;
  payload: string;
  ts: number;
}

/**
 * Handle returned from {@link startDaemon} for graceful shutdown / tests.
 */
export interface DaemonHandle {
  /** Actual port the WS server bound to. */
  port: number;
  /** Stop polling, close all sockets. Resolves once done. */
  stop: () => Promise<void>;
}

/**
 * Start the single-process fan-out daemon.
 *
 * Tails the `events` outbox in queue.db via short polling and pushes each
 * new row to connected WebSocket clients that are subscribed to its type
 * (or `'*'`). Uses the shared libsql client singleton — no second connection.
 *
 * TODO(security): no auth/TLS — bind only to localhost in production until
 * we add a token or move to a Unix domain socket.
 *
 * TODO(perf): replace `setInterval` polling with a change notification hook
 * once libsql exposes one; would drop tail latency from ~50ms p50 to near
 * zero on the same process boundary.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const port = opts.port ?? (Number(process.env.BUS_PORT) || 7777);
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const batchSize = opts.batchSize ?? 500;

  const client = getClient();

  let cursor = 0;
  if (!opts.fromStart) {
    const result = await client.execute(
      'SELECT COALESCE(MAX(id), 0) AS m FROM events',
    );
    cursor = Number(
      (result.rows[0] as unknown as { m: number | bigint }).m ?? 0,
    );
  }

  const wss = new WebSocketServer({ port });
  const clients = new Set<ClientState>();

  wss.on('connection', (ws) => {
    const state: ClientState = { ws, topics: new Set() };
    clients.add(state);
    log('debug', 'client connected', { totalClients: clients.size });

    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log('warn', 'invalid client JSON');
        return;
      }
      handleClientMessage(state, msg);
    });

    ws.on('close', () => {
      clients.delete(state);
      log('debug', 'client disconnected', { totalClients: clients.size });
    });

    ws.on('error', (err) => {
      log('warn', 'client socket error', { err: String(err) });
    });
  });

  function handleClientMessage(state: ClientState, msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { action?: unknown; types?: unknown; fromId?: unknown };
    switch (m.action) {
      case 'subscribe': {
        const types = Array.isArray(m.types) ? m.types : [];
        for (const t of types) {
          if (typeof t !== 'string') continue;
          if (t === '*' || isEventName(t)) state.topics.add(t);
        }
        return;
      }
      case 'unsubscribe': {
        const types = Array.isArray(m.types) ? m.types : [];
        for (const t of types) {
          if (typeof t === 'string') state.topics.delete(t);
        }
        return;
      }
      case 'replay': {
        const fromId = typeof m.fromId === 'number' ? m.fromId : 0;
        replayTo(state, fromId).catch((err) => {
          log('error', 'replay failed', { err: String(err) });
        });
        return;
      }
      default:
        log('warn', 'unknown client action', { action: m.action });
    }
  }

  async function replayTo(state: ClientState, fromId: number): Promise<void> {
    const result = await client.execute({
      sql: 'SELECT id, type, payload, ts FROM events WHERE id > ? ORDER BY id',
      args: [fromId],
    });
    for (const row of result.rows as unknown as RawEventRow[]) {
      sendIfSubscribed(state, row);
    }
  }

  function sendIfSubscribed(state: ClientState, row: RawEventRow): void {
    if (state.ws.readyState !== state.ws.OPEN) return;
    if (!state.topics.has('*') && !state.topics.has(row.type)) return;
    const wire = {
      id: row.id,
      type: row.type,
      payload: safeParseJson(row.payload),
      ts: row.ts,
    };
    state.ws.send(JSON.stringify(wire));
  }

  function safeParseJson(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  let stopped = false;
  // Guard against overlapping async polls.
  let polling = false;

  const timer: NodeJS.Timeout = setInterval(() => {
    if (stopped || polling) return;
    polling = true;
    client
      .execute({
        sql: 'SELECT id, type, payload, ts FROM events WHERE id > ? ORDER BY id LIMIT ?',
        args: [cursor, batchSize],
      })
      .then((result) => {
        const rows = result.rows as unknown as RawEventRow[];
        if (rows.length === 0) return;
        for (const row of rows) {
          for (const state of clients) {
            sendIfSubscribed(state, row);
          }
        }
        cursor = rows[rows.length - 1]!.id;
        log('debug', 'fan-out batch', { count: rows.length, maxId: cursor });
      })
      .catch((err) => {
        log('error', 'poll failed', { err: String(err) });
      })
      .finally(() => {
        polling = false;
      });
  }, pollIntervalMs);

  function installSignalHandlers(handle: DaemonHandle): void {
    const onSignal = (sig: string) => {
      log('info', `received ${sig}, shutting down`);
      handle.stop().then(
        () => process.exit(0),
        (err) => {
          log('error', 'shutdown error', { err: String(err) });
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }

  const handle: DaemonHandle = {
    port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const state of clients) {
        try {
          state.ws.close();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      log('info', 'daemon stopped');
    },
  };

  installSignalHandlers(handle);
  log('info', `listening on :${port}`);
  return handle;
}

/** Re-export `EventName` so script entry points can stay in one import. */
export type { EventName };
