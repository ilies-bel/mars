import type { Agent } from '@/shared/schemas'

interface ToolsCardProps {
  agent: Agent
}

export const ToolsCard = ({ agent }: ToolsCardProps) => {
  const allowed = agent.allowedTools
  const denied = agent.deniedTools

  return (
    <div className="flex w-full flex-col gap-[10px] rounded-lg border border-border bg-surface p-[18px]">
      <div className="flex items-baseline gap-3">
        <h3
          className="font-mono text-[10px] uppercase text-fg"
          style={{ letterSpacing: '1.2px' }}
        >
          TOOLS
        </h3>
        <span className="font-mono text-[11px] text-muted">
          {allowed.length} allowed · {denied.length} disallowed
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {allowed.length === 0 && denied.length === 0 ? (
          <span className="font-mono text-[11px] text-muted">
            No tools pinned — defaults apply.
          </span>
        ) : null}
        {allowed.map((tool) => (
          <span
            key={`allowed-${tool}`}
            className="rounded border border-border bg-neutral-100 px-2 py-0.5 font-mono text-[11px] text-fg"
          >
            {tool}
          </span>
        ))}
        {denied.map((tool) => (
          <span
            key={`denied-${tool}`}
            className="rounded bg-iron/10 px-2 py-0.5 font-mono text-[11px] text-iron"
          >
            <span aria-hidden="true">⊘ </span>
            {tool}
          </span>
        ))}
      </div>
    </div>
  )
}
