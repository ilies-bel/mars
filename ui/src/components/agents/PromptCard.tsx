import type { Agent } from '@/shared/schemas'

interface PromptCardProps {
  agent: Agent
}

const ROLE_SUMMARY: Record<string, string> = {
  implement:
    'Coder runs the code step of the implement workflow. It opens the worktree on `task/<id>`, applies the requested change, and commits before the verify step takes over.',
  plan: 'Planner synthesises the functional and technical plan for a queued task before the slicer turns it into implementor prompts.',
  slice:
    'Slicer breaks an approved plan into discrete implementor prompts. Each slice becomes a single Coder session.',
  triage:
    'Triager classifies failed task runs and routes them to the matching recovery recipe. Read-only and capped at 40 messages so a stuck triage fails fast.',
  fix: 'Fixer runs the fix-task recovery recipe when a Coder session lands without a usable commit. Backlog-mutation tools are denied so it cannot refile the failing task.',
  'vcs-supervisor':
    'Vega resolves merge conflicts by reconciling intent across both branches rather than picking one side blindly.',
}

const placeholderPrompt = (agent: Agent): string => {
  const summary =
    ROLE_SUMMARY[agent.role] ??
    `${agent.name} is a Mars worker pinned to ${agent.model}.`
  return [
    `# ${agent.name}`,
    '',
    summary,
    '',
    '## Rules',
    '- Stay inside the worktree handed to you.',
    '- Save your work — the orchestrator does not commit on your behalf.',
    '- Honour the denied-tool list; it is enforced at the wrapper layer.',
  ].join('\n')
}

export const PromptCard = ({ agent }: PromptCardProps) => {
  const body = placeholderPrompt(agent)

  return (
    <div className="flex w-full flex-col gap-[10px] rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-baseline gap-3">
        <h3
          className="font-mono text-[10px] uppercase text-fg"
          style={{ letterSpacing: '1.2px' }}
        >
          SYSTEM PROMPT
        </h3>
        <span className="font-mono text-[11px] text-muted">
          rendered markdown · scroll for full
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase text-muted">
          (placeholder — wire to real prompt source in a follow-up)
        </span>
      </div>
      <div
        className="flex flex-col gap-2 overflow-auto rounded-md bg-neutral-50 p-[14px]"
        style={{ maxHeight: 320 }}
      >
        <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-fg">
          {body}
        </pre>
      </div>
    </div>
  )
}
