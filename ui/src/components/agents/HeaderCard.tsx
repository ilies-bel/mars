import type { Agent } from '@/shared/schemas'

interface HeaderCardProps {
  agent: Agent
}

interface RoleMeta {
  invokedBy: string
  description: string
}

// Static, deterministic copy keyed off the worker role exported by the
// /api/agents server. The orchestrator does not yet expose a description
// string on `WORKER_CONFIGS`, so this map is the single source of truth
// for the human-readable blurbs the Agents pane shows.
const ROLE_META: Record<string, RoleMeta> = {
  implement: {
    invokedBy: 'implement-workflow · code step',
    description:
      'Runs the code step inside the implement workflow — opens the worktree, applies the change, and commits before the verify step takes over.',
  },
  plan: {
    invokedBy: 'implement-workflow · plan step',
    description:
      'Synthesises the high-level functional and technical plan for a queued task before the slicer breaks it into implementor prompts.',
  },
  slice: {
    invokedBy: 'implement-workflow · slice step',
    description:
      'Slices an approved plan into discrete implementor prompts. Each slice becomes a single Coder session inside the implement workflow.',
  },
  triage: {
    invokedBy: 'triage-workflow · triage step',
    description:
      'Triages failed task runs and routes them to the appropriate recovery recipe. Read-only and capped at 40 messages so a stuck triage fails fast.',
  },
  fix: {
    invokedBy: 'fix-task recipe · code step',
    description:
      'Runs the fix-task recovery recipe when a Coder session lands without a usable commit. Backlog-mutation tools are denied so it cannot refile the failing task.',
  },
  'vcs-supervisor': {
    invokedBy: 'merge step · conflict resolution',
    description:
      'Resolves merge conflicts during the merge step by reconciling intent across both branches rather than blindly picking one side.',
  },
}

const sourceRefFor = (role: string): string | null => {
  if (role === 'vcs-supervisor') return '.claude/agents/vcs-supervisor.md'
  return null
}

export const HeaderCard = ({ agent }: HeaderCardProps) => {
  const meta = ROLE_META[agent.role]
  const invokedBy = meta?.invokedBy ?? agent.name
  const description =
    meta?.description ??
    `${agent.name} is a Mars worker pinned to ${agent.model}.`
  const sourceRef = sourceRefFor(agent.role)

  return (
    <div className="flex w-full flex-col gap-[10px] rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-center gap-3">
        <h2 className="text-[18px] font-semibold leading-tight text-fg">
          {agent.name}
        </h2>
        <span
          className="rounded bg-flame/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-flame"
          style={{ letterSpacing: '0.6px' }}
        >
          DISPATCHED
        </span>
        <span className="rounded border border-border bg-neutral-200 px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg">
          {agent.model}
        </span>
        {sourceRef !== null && (
          <span className="ml-auto truncate font-mono text-[11px] text-muted">
            {sourceRef}
          </span>
        )}
      </div>
      <p
        className="text-[12px] text-fg"
        style={{ lineHeight: 1.5, maxWidth: 640 }}
      >
        {description}
      </p>
      <div className="flex items-center gap-2 pt-1">
        <span
          className="font-mono text-[10px] uppercase text-muted"
          style={{ letterSpacing: '1.2px' }}
        >
          INVOKED BY
        </span>
        <span className="rounded bg-neutral-200 px-2 py-0.5 font-mono text-[11px] text-fg">
          {invokedBy}
        </span>
      </div>
    </div>
  )
}
