import { useEffect, useState } from 'react'
import { HeaderCard } from '../components/agents/HeaderCard'
import { PromptCard } from '../components/agents/PromptCard'
import { ToolsCard } from '../components/agents/ToolsCard'
import { useAgents } from '../hooks/useAgents'
import type { Agent } from '@/shared/schemas'

interface TopBarProps {
  title: string
  count?: number
  hint: string
}

const TopBar = ({ title, count, hint }: TopBarProps) => (
  <header className="flex items-center gap-3 px-6 pt-6">
    <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
      {title}
    </h1>
    <span
      className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-iron"
      aria-label="count"
    >
      {count ?? '—'}
    </span>
    <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-iron">
      {hint}
    </span>
  </header>
)

interface AgentListProps {
  agents: Agent[]
  selectedName: string | null
  onSelect: (name: string) => void
}

const AgentList = ({ agents, selectedName, onSelect }: AgentListProps) => (
  <aside
    className="flex w-[340px] shrink-0 flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-surface p-3"
    aria-label="Agents master list"
  >
    <div
      className="flex items-center justify-between px-1 pb-2 font-mono text-[10px] uppercase text-muted"
      style={{ letterSpacing: '1.2px' }}
    >
      <span>AGENTS</span>
      <span className="font-mono text-[11px] text-muted">{agents.length}</span>
    </div>
    {agents.map((agent) => {
      const active = agent.name === selectedName
      return (
        <button
          key={agent.name}
          type="button"
          onClick={() => onSelect(agent.name)}
          className={[
            'flex flex-col items-start gap-0.5 rounded px-2.5 py-2 text-left',
            active
              ? 'border-l-2 border-flame bg-flame/10'
              : 'border-l-2 border-transparent hover:bg-panel',
          ].join(' ')}
        >
          <span className="text-[13px] font-semibold text-fg">
            {agent.name}
          </span>
          <span className="font-mono text-[10px] text-muted">{agent.role}</span>
        </button>
      )
    })}
  </aside>
)

export const AgentsPage = () => {
  const { agents, error } = useAgents()
  const [selectedName, setSelectedName] = useState<string | null>(null)

  useEffect(() => {
    if (!agents || selectedName) return
    if (agents.length > 0) setSelectedName(agents[0].name)
  }, [agents, selectedName])

  const selectedAgent =
    agents?.find((a) => a.name === selectedName) ?? agents?.[0] ?? null

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      <TopBar
        title="Agents"
        count={agents?.length}
        hint="system prompt · tools · recent runs"
      />
      <div className="flex min-h-0 flex-1 gap-4 px-6 pt-3 pb-6">
        {error ? (
          <section
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-6 text-iron"
            aria-label="Agent detail"
          >
            <p className="font-mono text-[12px]">Failed to load agents: {error}</p>
          </section>
        ) : !agents ? (
          <section
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-6 text-muted"
            aria-label="Agent detail"
          >
            <p className="font-mono text-[12px]">Loading agents…</p>
          </section>
        ) : (
          <>
            <AgentList
              agents={agents}
              selectedName={selectedAgent?.name ?? null}
              onSelect={setSelectedName}
            />
            <section
              className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto"
              aria-label="Agent detail"
            >
              {selectedAgent ? (
                <>
                  <HeaderCard agent={selectedAgent} />
                  <ToolsCard agent={selectedAgent} />
                  <PromptCard agent={selectedAgent} />
                </>
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg border border-border bg-surface p-6 text-muted">
                  <p className="font-mono text-[12px]">Select an agent</p>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
