import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../src/index.js';
import { listSessions, start } from '../src/index.js';

describe('listSessions', () => {
  const handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles) {
      try { handle.pty.kill(); } catch { /* already dead */ }
      await handle.exited.catch(() => { /* ignore */ });
    }
    handles.length = 0;
  });

  it('returns an empty collection when no sessions are active', () => {
    expect(listSessions()).toHaveLength(0);
  });

  it('includes both sessions after starting two', async () => {
    const a = await start({
      id: 'list-two-a',
      cwd: process.cwd(),
      args: ['sh', '-c', 'read line'],
      env: {},
    });
    const b = await start({
      id: 'list-two-b',
      cwd: process.cwd(),
      args: ['sh', '-c', 'read line'],
      env: {},
    });
    handles.push(a, b);

    const ids = listSessions().map(s => s.id);
    expect(ids).toContain('list-two-a');
    expect(ids).toContain('list-two-b');
  });

  it('excludes a session after it exits, keeping the surviving session', async () => {
    const survivor = await start({
      id: 'list-survivor',
      cwd: process.cwd(),
      args: ['sh', '-c', 'read line'],
      env: {},
    });
    const exiting = await start({
      id: 'list-exiting',
      cwd: process.cwd(),
      args: ['sh', '-c', 'exit 0'],
      env: {},
    });
    handles.push(survivor, exiting);

    await exiting.exited;

    const ids = listSessions().map(s => s.id);
    expect(ids).toContain('list-survivor');
    expect(ids).not.toContain('list-exiting');
  });
});
