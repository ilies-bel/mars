export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly result: GitResult,
    public readonly cwd: string,
  ) {
    super(
      `git ${args.join(' ')} failed (exit ${result.exitCode}) in ${cwd}\n` +
        `stderr: ${result.stderr.trim() || '(empty)'}`,
    );
    this.name = 'GitError';
  }
}

export async function git(args: string[], opts: { cwd: string }): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function gitOrThrow(args: string[], opts: { cwd: string }): Promise<GitResult> {
  const result = await git(args, opts);
  if (result.exitCode !== 0) {
    throw new GitError(args, result, opts.cwd);
  }
  return result;
}
