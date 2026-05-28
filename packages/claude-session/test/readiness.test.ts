import { describe, expect, it } from 'vitest';
import { getSession, start } from '../src/index.js';
import { READINESS_MARKER } from '../src/readiness.js';

// A distinct test-only marker so fake programs don't need to emit Claude's
// actual startup banner.
const TEST_MARKER = '--ready--';

describe('readiness detection', () => {
  it('start blocks until the readiness marker appears in PTY output', async () => {
    // Fake program: prints the marker after 60 ms, then the process exits
    // naturally once the event loop drains.
    const before = Date.now();

    const handle = await start({
      id: 'readiness-delay',
      cwd: process.cwd(),
      args: [
        process.execPath,
        '-e',
        `setTimeout(() => { process.stdout.write('${TEST_MARKER}'); }, 60);`,
      ],
      env: {},
      readinessMarker: TEST_MARKER,
    });

    const elapsed = Date.now() - before;

    // start must not have resolved before the marker was emitted.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(handle.id).toBe('readiness-delay');

    // Let the process finish naturally (the event loop drains after setTimeout).
    await handle.exited;
  });

  it('start rejects when the process exits before the readiness marker is seen', async () => {
    const promise = start({
      id: 'readiness-early-exit',
      cwd: process.cwd(),
      args: ['sh', '-c', 'exit 3'],
      env: {},
      readinessMarker: TEST_MARKER,
    });

    await expect(promise).rejects.toThrow(/exit/i);

    // The registry must not retain a phantom session after the process exits.
    expect(getSession('readiness-early-exit')).toBeUndefined();
  });

  it('resolves immediately when a fake program emits the library READINESS_MARKER', async () => {
    // Verifies the exported constant is a non-empty usable string.
    const handle = await start({
      id: 'readiness-marker-constant',
      cwd: process.cwd(),
      args: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(READINESS_MARKER)});`,
      ],
      env: {},
      readinessMarker: READINESS_MARKER,
    });

    expect(handle.id).toBe('readiness-marker-constant');
    await handle.exited;
  });
});
