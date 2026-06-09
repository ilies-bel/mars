import * as pty from 'node-pty'

export interface PtyHandle {
  write(data: string): void
  kill(signal?: NodeJS.Signals): void
  onData(cb: (chunk: string) => void): void
  onExit(cb: (code: number, signal: number) => void): void
  buffer(): string
}

export const spawnPty = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; cols?: number; rows?: number },
): PtyHandle => {
  let accumulated = ''
  const dataListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(code: number, signal: number) => void> = []

  const term = pty.spawn(cmd, args as string[], {
    cwd: opts.cwd,
    env: (opts.env ?? process.env) as Record<string, string>,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
  })

  term.onData((chunk) => {
    accumulated += chunk
    for (const cb of dataListeners) {
      cb(chunk)
    }
  })

  term.onExit(({ exitCode, signal }) => {
    for (const cb of exitListeners) {
      cb(exitCode ?? 0, signal ?? 0)
    }
  })

  return {
    write(data: string): void {
      term.write(data)
    },

    kill(signal?: NodeJS.Signals): void {
      term.kill(signal)
    },

    onData(cb: (chunk: string) => void): void {
      dataListeners.push(cb)
    },

    onExit(cb: (code: number, signal: number) => void): void {
      exitListeners.push(cb)
    },

    buffer(): string {
      return accumulated
    },
  }
}
