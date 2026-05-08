import { useMemo } from 'react'
import { useQuestions } from '../hooks/useQuestions'
import type { Question, QuestionCategory, TaskSuggestion } from '../lib/types'

interface TaskGroup {
  taskId: string
  prompt: string
  questions: Question[]
  suggestions: TaskSuggestion[]
}

const groupByTask = (
  questions: Question[],
  suggestions: TaskSuggestion[],
): TaskGroup[] => {
  const map = new Map<string, TaskGroup>()
  for (const q of questions) {
    const g = map.get(q.taskId) ?? {
      taskId: q.taskId,
      prompt: q.taskPrompt,
      questions: [],
      suggestions: [],
    }
    g.questions.push(q)
    if (!g.prompt && q.taskPrompt) g.prompt = q.taskPrompt
    map.set(q.taskId, g)
  }
  for (const s of suggestions) {
    const g = map.get(s.sourceTaskId) ?? {
      taskId: s.sourceTaskId,
      prompt: '',
      questions: [],
      suggestions: [],
    }
    g.suggestions.push(s)
    map.set(s.sourceTaskId, g)
  }
  return [...map.values()].sort((a, b) => a.taskId.localeCompare(b.taskId))
}

const categoryColor = (c: QuestionCategory | null): string => {
  switch (c) {
    case 'scope':
      return 'bg-flame/20 text-flame'
    case 'tech':
      return 'bg-iron/30 text-fg'
    case 'ux':
      return 'bg-flame/10 text-flame'
    case 'risk':
      return 'bg-iron/40 text-fg'
    default:
      return 'bg-iron/20 text-iron'
  }
}

const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return first.length > 0 ? first : prompt.trim()
}

export const QuestionsPage = () => {
  const { questions, suggestions, error } = useQuestions()
  const groups = useMemo(
    () => groupByTask(questions, suggestions),
    [questions, suggestions],
  )

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <header className="border-b border-iron/30 px-6 py-3">
        <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
          Questions
        </h1>
        <p className="mt-1 font-mono text-[11px] text-iron">
          Open questions and follow-up task suggestions across all draft specs.
        </p>
      </header>

      <main className="flex-1 overflow-auto px-6 py-4">
        {groups.length === 0 ? (
          <div className="font-mono text-[12px] text-iron">
            No questions yet. Run{' '}
            <code className="rounded bg-iron/20 px-1">
              mars add --draft "&lt;spec&gt;"
            </code>{' '}
            to generate some.
          </div>
        ) : (
          <ul className="flex flex-col gap-6">
            {groups.map((g) => (
              <li
                key={g.taskId}
                className="rounded border border-iron/30 bg-bg p-4"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] uppercase text-iron">
                    T{g.taskId.slice(0, 8)}
                  </span>
                  <span className="font-mono text-[13px] text-fg">
                    {titleFromPrompt(g.prompt) || '(no prompt)'}
                  </span>
                </div>

                {g.questions.length > 0 ? (
                  <section className="mt-3">
                    <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-iron">
                      Questions ({g.questions.length})
                    </h2>
                    <ul className="flex flex-col gap-2">
                      {g.questions.map((q) => (
                        <li
                          key={q.id}
                          className="rounded border border-iron/20 bg-iron/5 p-2"
                        >
                          <div className="flex items-start gap-2">
                            <span
                              className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${categoryColor(q.category)}`}
                            >
                              {q.category ?? 'q'}
                            </span>
                            <span className="font-mono text-[12px] text-fg">
                              {q.question}
                            </span>
                          </div>
                          {q.rationale ? (
                            <p className="mt-1 pl-[3.25rem] font-mono text-[11px] text-iron">
                              {q.rationale}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {g.suggestions.length > 0 ? (
                  <section className="mt-3">
                    <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-iron">
                      Suggested tasks ({g.suggestions.length})
                    </h2>
                    <ul className="flex flex-col gap-2">
                      {g.suggestions.map((s) => (
                        <li
                          key={s.id}
                          className="rounded border border-iron/20 bg-iron/5 p-2"
                        >
                          <div className="font-mono text-[12px] text-fg">
                            {s.title}
                          </div>
                          <div className="mt-1 font-mono text-[11px] text-iron">
                            {s.prompt}
                          </div>
                          {s.rationale ? (
                            <div className="mt-1 font-mono text-[10px] text-iron/80">
                              {s.rationale}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </li>
            ))}
          </ul>
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
