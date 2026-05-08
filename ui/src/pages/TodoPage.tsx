import { useTodo } from '../hooks/useTodo'
import type { DraftFeature, TaskSuggestion } from '../lib/types'

const shortId = (id: string): string => id.slice(0, 8)

const draftLabel = (d: DraftFeature): string =>
  d.goal.trim() || '(no goal)'

const suggestionLabel = (s: TaskSuggestion): string =>
  s.title.trim() || s.prompt.trim().split(/\r?\n/, 1)[0] || '(untitled)'

export const TodoPage = () => {
  const { drafts, suggestions, error } = useTodo()
  const empty = drafts.length === 0 && suggestions.length === 0

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <header className="border-b border-iron/30 px-6 py-3">
        <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
          Todo
        </h1>
        <p className="mt-1 font-mono text-[11px] text-iron">
          Pick the next thing to refine. Run{' '}
          <code className="rounded bg-iron/20 px-1">
            /mars:next &lt;id&gt;
          </code>{' '}
          in Claude Code to shape it into a well-specified feature.
        </p>
      </header>

      <main className="flex-1 overflow-auto px-6 py-4">
        {empty ? (
          <div className="font-mono text-[12px] text-iron">
            Nothing to refine. Create a draft with{' '}
            <code className="rounded bg-iron/20 px-1">
              mars feature new "&lt;goal&gt;"
            </code>{' '}
            or run{' '}
            <code className="rounded bg-iron/20 px-1">/mars:next</code> to
            start one from scratch.
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {drafts.length > 0 ? (
              <section>
                <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-iron">
                  Existing drafts ({drafts.length})
                </h2>
                <ul className="flex flex-col gap-2">
                  {drafts.map((d) => (
                    <li
                      key={d.id}
                      className="rounded border border-iron/30 bg-bg p-3"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[11px] uppercase text-iron">
                          {shortId(d.id)}
                        </span>
                        <span className="font-mono text-[13px] text-fg">
                          {draftLabel(d)}
                        </span>
                      </div>
                      <div className="mt-1 flex gap-3 font-mono text-[10px] uppercase text-iron/80">
                        <span>
                          story: {d.story.trim() ? 'set' : 'empty'}
                        </span>
                        <span>
                          technical: {d.technical.trim() ? 'set' : 'empty'}
                        </span>
                        <span>acceptance: {d.acceptanceCount}</span>
                      </div>
                      <div className="mt-2 font-mono text-[11px] text-iron">
                        Refine:{' '}
                        <code className="rounded bg-iron/20 px-1">
                          /mars:next {d.id}
                        </code>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {suggestions.length > 0 ? (
              <section>
                <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-iron">
                  Reflection suggestions ({suggestions.length})
                </h2>
                <p className="mb-2 font-mono text-[11px] text-iron/80">
                  Would become new drafts.
                </p>
                <ul className="flex flex-col gap-2">
                  {suggestions.map((s) => (
                    <li
                      key={s.id}
                      className="rounded border border-iron/30 bg-bg p-3"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[11px] uppercase text-iron">
                          {shortId(s.id)}
                        </span>
                        <span className="font-mono text-[13px] text-fg">
                          {suggestionLabel(s)}
                        </span>
                      </div>
                      {s.rationale ? (
                        <div className="mt-1 font-mono text-[11px] text-iron">
                          {s.rationale}
                        </div>
                      ) : null}
                      <div className="mt-2 font-mono text-[11px] text-iron">
                        Promote:{' '}
                        <code className="rounded bg-iron/20 px-1">
                          /mars:next {s.id}
                        </code>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </main>

      {error ? (
        <div className="border-t border-iron/40 bg-iron/10 px-6 py-1.5 font-mono text-[11px] text-iron">
          {error}
        </div>
      ) : null}
    </div>
  )
}
