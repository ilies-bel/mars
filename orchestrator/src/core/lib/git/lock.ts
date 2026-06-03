import { resolve } from 'node:path'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM means the process exists but we don't have permission to signal it.
    if (code === 'EPERM') return true
    return false
  }
}

const isLockStale = async (lockPath: string): Promise<boolean> => {
  try {
    const contents = (await readFile(lockPath, 'utf8')).trim()
    if (!contents) return true
    const pid = Number.parseInt(contents, 10)
    if (!Number.isInteger(pid) || pid <= 0) return true
    if (pid === process.pid) return true
    return !isPidAlive(pid)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // The lock vanished between our failed open and the read — treat as stale
    // so the next open attempt can claim it.
    if (code === 'ENOENT') return true
    return false
  }
}

export const acquireLock = async (
  lockPath: string,
  timeoutMs: number,
): Promise<() => Promise<void>> => {
  await mkdir(resolve(lockPath, '..'), { recursive: true })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.write(String(process.pid))
      return async () => {
        await handle.close()
        await unlink(lockPath).catch(() => {})
      }
    } catch {
      // If the existing lock's owner is dead (or the file is empty/corrupt),
      // reclaim it. The retry loop handles TOCTOU: if another process beats
      // us to unlink+open, our next `open(..., 'wx')` simply fails and we
      // fall back to polling.
      if (await isLockStale(lockPath)) {
        await unlink(lockPath).catch(() => {})
        continue
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error(`Failed to acquire merge lock after ${timeoutMs}ms`)
}
