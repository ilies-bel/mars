/**
 * DocumentWriteCoordinator — per-unit serialization for structured writes.
 *
 * Replaces the global `structuredWriteSem` shared by all document-kind
 * dispatchers. Two writes to the same unit path (e.g. a glossary file, the
 * canonical vision.md) queue behind each other; two writes targeting distinct
 * paths execute concurrently with no artificial serialization between them.
 *
 * Decision records (ADRs) each land in a unique numbered file so they never
 * share a unit path and therefore never contend here — they bypass the
 * coordinator entirely and rely on the atomic file-number allocator for
 * correctness.
 *
 * The coordinator maintains a per-unit promise tail (the last queued
 * operation for that path). When a new operation arrives it is chained after
 * the current tail; when the tail settles (resolved or rejected) the Map
 * entry is deleted so the Map stays small. The caller receives the returned
 * Promise: vision writes await it; glossary writes ignore it (fire-and-
 * forget — their dispatcher catches errors internally via its own try/catch).
 */
export class DocumentWriteCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Run `operation` after any already-queued operation for `unitPath`.
   *
   * - Two calls with **different** `unitPath` values execute concurrently.
   * - Two calls with the **same** `unitPath` value execute sequentially: the
   *   second waits for the first to settle before starting.
   *
   * The returned Promise reflects the outcome of `operation` itself.  A
   * failure in the previous tail is suppressed so the next operation always
   * runs (the previous dispatcher already handles its own errors).
   */
  run(unitPath: string, operation: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(unitPath) ?? Promise.resolve()
    // Chain regardless of whether prev resolved or rejected: the previous
    // dispatcher's own try/catch already contains that failure.
    const tail = prev.then(() => operation(), () => operation())
    this.tails.set(unitPath, tail)
    // Clean up once this tail settles and no newer tail replaced it.
    void tail.finally(() => {
      if (this.tails.get(unitPath) === tail) {
        this.tails.delete(unitPath)
      }
    })
    return tail
  }
}
