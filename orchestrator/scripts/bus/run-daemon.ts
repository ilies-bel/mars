#!/usr/bin/env tsx
/**
 * CLI entry for the bus fan-out daemon.
 *
 * Flags:
 *   --from-start          replay every historical event to new clients
 *   --port <n>            override BUS_PORT / default 7777
 *   --db <path>           override BUS_DB / default ./app.db
 */
import { startDaemon } from '../../src/bus/daemon.js';

interface ParsedArgs {
  fromStart: boolean;
  port?: number;
  dbPath?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { fromStart: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-start') {
      out.fromStart = true;
    } else if (a === '--port') {
      const v = argv[++i];
      if (!v) throw new Error('--port requires a value');
      out.port = Number(v);
    } else if (a === '--db') {
      const v = argv[++i];
      if (!v) throw new Error('--db requires a value');
      out.dbPath = v;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
startDaemon({
  fromStart: args.fromStart,
  port: args.port,
  dbPath: args.dbPath,
});

// Keep the process alive — the daemon owns its own timers and WS server,
// but tsx will exit when there's nothing left on the event loop. The
// active interval inside startDaemon already prevents that, so no extra
// keep-alive is required here.
