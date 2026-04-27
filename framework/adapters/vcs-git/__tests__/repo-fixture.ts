import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOrThrow } from '../git.ts';

export type Fixture = {
  root: string;
  cleanup: () => Promise<void>;
};

export async function createRepo(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'mars-vcs-test-'));
  await gitOrThrow(['init', '-b', 'main'], { cwd: root });
  await gitOrThrow(['config', 'user.email', 'test@mars.local'], { cwd: root });
  await gitOrThrow(['config', 'user.name', 'Mars Test'], { cwd: root });
  await gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: root });
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await gitOrThrow(['add', 'README.md'], { cwd: root });
  await gitOrThrow(['commit', '-m', 'init'], { cwd: root });
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeAt(root: string, relPath: string, contents: string): Promise<void> {
  const abs = join(root, relPath);
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  if (dir && dir !== root) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(abs, contents);
}
