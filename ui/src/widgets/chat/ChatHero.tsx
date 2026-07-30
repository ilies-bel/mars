/**
 * ChatHero — inline delta of everything since the last visit.
 *
 * Renders a five-section plain-English summary above the composer when the
 * operator returns after idle time. No modal, no dialog — the delta lives
 * inline so the composer remains reachable at all times.
 *
 * Sections rendered (each omitted when empty):
 *   - Merges        — tasks that landed since last visit
 *   - Recoveries    — recovery tasks that completed
 *   - Recipes       — recipe auto-run events (taught recipes that fired)
 *   - Throttles     — threads that were rate-limited
 *   - Evaporated    — projection Threads whose alert was resolved
 */

// ── Entry type definitions ────────────────────────────────────────────────────
// These mirror the corresponding types in ui/server/releaseNotes.ts. The client
// only receives these types through API responses, so they are re-declared here
// rather than imported from server code.

/** A task that fully landed (status done) since the last visit. */
export interface MergeEntry {
  kind: 'merge'
  taskId: string
  title: string
  at: string
}

/** A recovery (fix/diagnose) task that completed since the last visit. */
export interface RecoveryEntry {
  kind: 'recovery'
  taskId: string
  originTaskId: string
  title: string
  at: string
}

/** A recipe auto-run event: a taught recipe that fired automatically. */
export interface RecipeEntry {
  kind: 'recipe-autorun'
  text: string
}

/** A thread that was throttled (rate-limited) since the last visit. */
export interface ThrottleEntry {
  kind: 'throttle'
  taskId: string
  reason: string
  at: string
}

/** A projection Thread whose alert resolved and the row evaporated. */
export interface EvaporatedEntry {
  kind: 'evaporated'
  threadId: string
  title: string
  at: string
}

/** Grouped delta of everything that happened since the last visit. */
export interface HeroDelta {
  merges: MergeEntry[]
  recoveries: RecoveryEntry[]
  recipes: RecipeEntry[]
  throttles: ThrottleEntry[]
  evaporated: EvaporatedEntry[]
}

export interface ChatHeroProps {
  /** The delta to display. Each non-empty section renders its own header. */
  delta: HeroDelta
  /** Called when the user dismisses the delta view. */
  onBack: () => void
}

// ── Section header class ──────────────────────────────────────────────────────

const SECTION_HEADER = 'font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground mb-2'
const SECTION_WRAPPER = 'flex flex-col gap-0.5'
const ITEM_ROW = 'font-mono text-[12px] text-foreground/80'
const TASK_ID = 'text-primary font-semibold mr-1'

// ── ChatHero ─────────────────────────────────────────────────────────────────

/**
 * Inline "what happened while you were away" delta view.
 *
 * Shown above the hero composer when the operator returns after idling. Each
 * non-empty section renders a labelled list; empty sections are omitted so the
 * view is tight on a quiet day.
 */
export const ChatHero = ({ delta, onBack }: ChatHeroProps) => {
  const hasContent =
    delta.merges.length > 0 ||
    delta.recoveries.length > 0 ||
    delta.recipes.length > 0 ||
    delta.throttles.length > 0 ||
    delta.evaporated.length > 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center border-b border-primary/30 px-4 py-2">
        <button
          type="button"
          data-testid="chat-hero-back"
          onClick={onBack}
          className="font-mono text-[11px] text-primary transition-colors hover:text-foreground"
        >
          ← Back to chat
        </button>
      </div>

      {/* Delta sections */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!hasContent ? (
          <p className="font-mono text-[13px] text-muted-foreground">
            Nothing new since your last visit.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {/* ── Merges ─────────────────────────────────────────────────── */}
            {delta.merges.length > 0 && (
              <section>
                <h3 data-testid="delta-section-merges" className={SECTION_HEADER}>
                  Merges
                </h3>
                <ul className={SECTION_WRAPPER}>
                  {delta.merges.map((m) => (
                    <li key={m.taskId} className={ITEM_ROW}>
                      ✅ <span className={TASK_ID}>{m.taskId}</span> {m.title}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── Recoveries ─────────────────────────────────────────────── */}
            {delta.recoveries.length > 0 && (
              <section>
                <h3 data-testid="delta-section-recoveries" className={SECTION_HEADER}>
                  Recoveries
                </h3>
                <ul className={SECTION_WRAPPER}>
                  {delta.recoveries.map((r) => (
                    <li key={r.taskId} className={ITEM_ROW}>
                      🔧 <span className={TASK_ID}>{r.originTaskId}</span> recovered — {r.title}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── Recipes ────────────────────────────────────────────────── */}
            {delta.recipes.length > 0 && (
              <section>
                <h3 data-testid="delta-section-recipes" className={SECTION_HEADER}>
                  Recipes
                </h3>
                <ul className={SECTION_WRAPPER}>
                  {delta.recipes.map((r, i) => (
                    <li key={i} data-testid="recipe-entry" className={ITEM_ROW}>
                      🤖 {r.text}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── Throttles ──────────────────────────────────────────────── */}
            {delta.throttles.length > 0 && (
              <section>
                <h3 data-testid="delta-section-throttles" className={SECTION_HEADER}>
                  Throttles
                </h3>
                <ul className={SECTION_WRAPPER}>
                  {delta.throttles.map((t) => (
                    <li key={t.taskId} className={ITEM_ROW}>
                      ⏸ <span className={TASK_ID}>{t.taskId}</span> {t.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── Evaporated ─────────────────────────────────────────────── */}
            {delta.evaporated.length > 0 && (
              <section>
                <h3 data-testid="delta-section-evaporated" className={SECTION_HEADER}>
                  Evaporated
                </h3>
                <ul className={SECTION_WRAPPER}>
                  {delta.evaporated.map((e) => (
                    <li key={e.threadId} className={ITEM_ROW}>
                      💨 {e.title}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
