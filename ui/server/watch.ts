import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/**
 * SQLite WAL files (-wal, -shm) get rotated on checkpoint, which breaks
 * file-level fs.watch on macOS. Watching the parent directory survives
 * inode changes and catches every mutation to queue.db / -wal / -shm.
 */
export const watchQueue = (
  dbPath: string,
  onChange: () => void,
  debounceMs = 50,
): (() => void) => {
  const dir = dirname(dbPath)
  const base = basename(dbPath)
  const wal = `${base}-wal`
  const shm = `${base}-shm`
  const targets = new Set([base, wal, shm])

  let timer: NodeJS.Timeout | null = null
  const fire = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  const watcher: FSWatcher = watch(dir, { persistent: true }, (_event, filename) => {
    if (filename && targets.has(String(filename))) fire()
  })

  return () => watcher.close()
}
