import {
  EventMap,
  type BusEvent,
  type EventName,
  type EventPayload,
  isEventName,
  parseEvent,
} from './events.js';

/**
 * Listener for a typed event channel. The handler receives the validated
 * payload for `T`. The wildcard listener (`'*'`) instead receives the
 * raw `BusEvent` envelope.
 */
type Listener<T extends EventName> = (payload: EventPayload<T>) => void;
type WildcardListener = (event: BusEvent) => void;

/**
 * Options accepted by {@link connectBus}.
 */
export interface ConnectBusOptions {
  /** Daemon URL, e.g. `ws://localhost:7777`. */
  url: string;
  /** Initial reconnect delay in ms. Default: 200. */
  initialBackoffMs?: number;
  /** Max reconnect delay in ms. Default: 5000. */
  maxBackoffMs?: number;
}

/**
 * Public bus client API. Returned (resolved) by {@link connectBus}.
 */
export interface BusClient {
  /** Subscribe to a typed event. Multiple listeners per type are allowed. */
  on<T extends EventName>(type: T, handler: Listener<T>): void;
  /** Subscribe to every event as a raw {@link BusEvent}. */
  on(type: '*', handler: WildcardListener): void;
  /** Remove a previously registered listener. */
  off<T extends EventName>(type: T, handler: Listener<T>): void;
  off(type: '*', handler: WildcardListener): void;
  /**
   * Register a callback fired each time the underlying socket connects
   * (including the first connect and every successful reconnect). Useful
   * for re-issuing `replay(lastSeenId)` so the consumer can resync after
   * a daemon restart without losing events.
   */
  onConnect(handler: () => void): void;
  /** Ask the daemon to replay every event with `id > fromId` to this client. */
  replay(fromId: number): Promise<void>;
  /** Disconnect, stop reconnecting, drop every listener. */
  close(): void;
}

/** Resolve a WebSocket constructor that works in Node and browsers. */
async function resolveWebSocket(): Promise<typeof WebSocket> {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  const ws = await import('ws');
  return ws.WebSocket as unknown as typeof WebSocket;
}

/**
 * Connect to the bus daemon.
 *
 * Auto-reconnects with exponential backoff (capped, jittered), tracks
 * subscribed types in memory, and re-issues the subscription on every
 * reconnect so the caller never has to manage transport lifecycle.
 */
export async function connectBus(opts: ConnectBusOptions): Promise<BusClient> {
  const initialBackoff = opts.initialBackoffMs ?? 200;
  const maxBackoff = opts.maxBackoffMs ?? 5000;

  const WS = await resolveWebSocket();

  const typedListeners = new Map<EventName, Set<Listener<EventName>>>();
  const wildcardListeners = new Set<WildcardListener>();
  const subscribedTypes = new Set<string>(); // includes '*'
  const connectListeners = new Set<() => void>();

  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = initialBackoff;
  let connectingPromise: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function send(obj: unknown): void {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  function applySubscriptions(): void {
    if (subscribedTypes.size === 0) return;
    send({ action: 'subscribe', types: Array.from(subscribedTypes) });
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const jitter = Math.random() * backoff * 0.3;
    const delay = Math.min(maxBackoff, backoff + jitter);
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(maxBackoff, backoff * 2);
      connect().catch(() => {
        /* connect already schedules another retry */
      });
    }, delay);
  }

  function handleEnvelope(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as { id?: unknown; type?: unknown; payload?: unknown; ts?: unknown };
    if (
      typeof r.id !== 'number' ||
      typeof r.type !== 'string' ||
      typeof r.ts !== 'number'
    ) {
      return;
    }
    if (!isEventName(r.type)) return;

    let payload: EventPayload<EventName>;
    try {
      payload = parseEvent(r.type, r.payload);
    } catch {
      return; // drop malformed
    }

    const event: BusEvent = { id: r.id, type: r.type, payload, ts: r.ts };

    const set = typedListeners.get(r.type);
    if (set) {
      for (const fn of set) {
        try {
          fn(payload);
        } catch {
          /* listener errors are isolated */
        }
      }
    }
    for (const fn of wildcardListeners) {
      try {
        fn(event);
      } catch {
        /* listener errors are isolated */
      }
    }
  }

  async function connect(): Promise<void> {
    if (closed) return;
    if (connectingPromise) return connectingPromise;
    connectingPromise = new Promise<void>((resolve) => {
      const sock = new WS(opts.url);
      ws = sock;

      sock.onopen = () => {
        backoff = initialBackoff;
        applySubscriptions();
        connectingPromise = null;
        for (const fn of connectListeners) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
        resolve();
      };
      sock.onmessage = (ev: MessageEvent) => {
        try {
          const data = typeof ev.data === 'string' ? ev.data : ev.data?.toString?.();
          if (typeof data !== 'string') return;
          handleEnvelope(JSON.parse(data));
        } catch {
          /* ignore malformed frames */
        }
      };
      sock.onclose = () => {
        ws = null;
        connectingPromise = null;
        scheduleReconnect();
        // resolve so the initial connect() awaiter doesn't hang on early
        // disconnect; reconnects continue in the background.
        resolve();
      };
      sock.onerror = () => {
        // browsers raise generic Event; ws raises Error. Either way, onclose
        // fires next and drives reconnects.
      };
    });
    return connectingPromise;
  }

  await connect();

  function ensureSubscribed(type: string): void {
    if (subscribedTypes.has(type)) return;
    subscribedTypes.add(type);
    send({ action: 'subscribe', types: [type] });
  }

  const client: BusClient = {
    on(type: EventName | '*', handler: Listener<EventName> | WildcardListener): void {
      if (type === '*') {
        wildcardListeners.add(handler as WildcardListener);
      } else {
        if (!(type in EventMap)) {
          throw new Error(`Unknown event type: ${String(type)}`);
        }
        let set = typedListeners.get(type);
        if (!set) {
          set = new Set();
          typedListeners.set(type, set);
        }
        set.add(handler as Listener<EventName>);
      }
      ensureSubscribed(type);
    },
    off(type: EventName | '*', handler: Listener<EventName> | WildcardListener): void {
      if (type === '*') {
        wildcardListeners.delete(handler as WildcardListener);
      } else {
        const set = typedListeners.get(type);
        if (set) {
          set.delete(handler as Listener<EventName>);
          if (set.size === 0) typedListeners.delete(type);
        }
      }
    },
    onConnect(handler: () => void): void {
      connectListeners.add(handler);
    },
    async replay(fromId: number): Promise<void> {
      send({ action: 'replay', fromId });
    },
    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      typedListeners.clear();
      wildcardListeners.clear();
      subscribedTypes.clear();
      connectListeners.clear();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },
  };

  return client;
}
