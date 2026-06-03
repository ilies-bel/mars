/**
 * End-to-end smoke test against the real interactive claude binary.
 *
 * Skipped automatically when the `claude` binary is absent from PATH so
 * environments without Claude Code still pass.  When it runs, the full PTY
 * transcript is streamed to stdout so a human reviewer can sign off in
 * test/e2e-real-claude.md.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import type { SessionHandle } from '../src/index.js';
import { getSession, start, READINESS_MARKER } from '../src/index.js';

// Resolve once at module load; skip the entire suite if the binary is absent.
const claudePath = (() => {
  try {
    return execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

describe.skipIf(!claudePath)('e2e: real claude binary', () => {
  const handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles) {
      if (getSession(handle.id)) {
        try { handle.kill(); } catch { /* already dead */ }
        await handle.exited.catch(() => { /* ignore */ });
      }
    }
    handles.length = 0;
  });

  it(
    'starts, waits for readiness, sends a message, observes a response, kills cleanly',
    async () => {
      // ── 1. Launch a real claude process ──────────────────────────────────
      // start() blocks until READINESS_MARKER (U+276F + U+00A0, the TUI
      // input prompt character + non-breaking space) is seen in the PTY
      // output, proving the readiness signal was observed.
      const handle = await start({
        id: 'e2e-real-claude',
        cwd: process.cwd(),
        args: [claudePath, '--dangerously-skip-permissions'],
        env: {},
        readinessMarker: READINESS_MARKER,
      });
      handles.push(handle);

      // start resolved → the binary is real and produced the readiness signal.
      expect(handle.id).toBe('e2e-real-claude');

      // ── 2. Capture all subsequent PTY output ─────────────────────────────
      const chunks: string[] = [];
      handle.onData((chunk) => {
        chunks.push(chunk);
        process.stdout.write(chunk); // stream live so a human watching can see it
      });

      // Give the TUI a moment to finish its final render cycles before we
      // write to stdin — the prompt character fires as soon as the input line
      // is active, but claude may still be flushing status-bar updates.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // ── 3. Send a trivial, deterministic prompt ───────────────────────────
      handle.sendMessage(
        'What is the capital of France? Reply with just the city name.',
      );

      // ── 4. Wait for "Paris" to appear in the streamed output ──────────────
      const responded = await new Promise<boolean>((resolve) => {
        const deadline = setTimeout(() => resolve(false), 60_000);
        const poll = setInterval(() => {
          if (chunks.join('').toLowerCase().includes('paris')) {
            clearInterval(poll);
            clearTimeout(deadline);
            resolve(true);
          }
        }, 200);
      });

      const transcript = chunks.join('');
      console.log('\n\n=== TRANSCRIPT START ===');
      console.log(transcript);
      console.log('=== TRANSCRIPT END ===\n');

      expect(
        responded,
        'Expected claude to reply with "Paris" within 60 s — see transcript above',
      ).toBe(true);

      // ── 5. Kill the session; exited must resolve with a numeric code ───────
      handle.kill();
      const exitCode = await handle.exited;

      console.log(`Exit code: ${exitCode}`);
      // SIGTERM on macOS/Linux yields a negative exit code; a graceful exit
      // yields 0.  Either is a valid clean termination.
      expect(typeof exitCode).toBe('number');
    },
    90_000, // 90 s — claude startup + first response can be slow
  );
});
