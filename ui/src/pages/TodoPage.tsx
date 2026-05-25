import { useMemo, useState } from 'react'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import type { ActionQueueItem, DagNode } from '@/shared/schemas'

// ---- Helpers ----

const formatTime = (iso: string): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

const priorityBadgeClass = (priority: string): string => {
  if (priority === 'high') return 'text-[#ff4f4f]'
  if (priority === 'normal') return 'text-[#ff944d]'
  return 'text-iron/60'
}

const KIND_LABEL: Record<ActionQueueItem['kind'], string> = {
  'failed-task': 'failed',
  'blocked-task': 'blocked',
  'stale-worktree': 'stale wt',
  'draft-proposal': 'draft',
}

// ---- Row ----

interface RowProps {
  item: ActionQueueItem
  active: boolean
  onSelect: () => void
}

const ActionQueueRow = ({ item, active, onSelect }: RowProps) => {
  const baseClass = [
    'cursor-pointer border-l-2 px-3 py-2 transition-colors',
    active ? 'border-fg bg-iron/20' : 'border-transparent hover:bg-iron/10',
  ].join(' ')

  return (
    <li className={baseClass} onClick={onSelect}>
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[9px] uppercase text-iron/80">
          {KIND_LABEL[item.kind]}
        </span>
        <span className="break-all font-mono text-[10px] text-iron">
          {item.entityId}
        </span>
        <span
          className={`ml-auto shrink-0 font-mono text-[9px] uppercase ${priorityBadgeClass(item.priority)}`}
        >
          {item.priority}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[12px] text-fg">
        {item.title || '(no title)'}
      </div>
      <div className="mt-1 font-mono text-[10px] text-iron/70">
        {formatTime(item.at)}
        {item.dismissed ? ' · dismissed' : ''}
      </div>
    </li>
  )
}

// ---- DAG sub-panel ----

interface DagListProps {
  label: string
  nodes: DagNode[]
}

const DagList = ({ label, nodes }: DagListProps) => {
  if (nodes.length === 0) return null
  return (
    <div>
      <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
        {label}
      </dt>
      <dd>
        <ul className="flex flex-col gap-1">
          {nodes.map((n) => (
            <li key={n.id} className="text-fg">
              <span className="text-iron">{n.id}</span>{' '}
              <span className="text-iron/60">({n.status})</span> {n.summary}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  )
}

// ---- Detail panel ----

interface DetailProps {
  item: ActionQueueItem
}

const ActionQueueDetail = ({ item }: DetailProps) => (
  <div className="flex h-full flex-col overflow-auto">
    <header className="border-b border-iron/30 px-6 py-4">
      <div className="flex items-baseline gap-3">
        <span className="break-all font-mono text-[11px] uppercase text-iron">
          {item.entityId}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-iron/80">
          {KIND_LABEL[item.kind]}
        </span>
        <span
          className={`ml-auto font-mono text-[10px] uppercase ${priorityBadgeClass(item.priority)}`}
        >
          {item.priority}
        </span>
      </div>
      <h2 className="mt-2 break-all font-mono text-[15px] text-fg">
        {item.title || '(no title)'}
      </h2>
    </header>

    <main className="flex-1 px-6 py-4">
      <dl className="flex flex-col gap-4 font-mono text-[12px]">
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Next action
          </dt>
          <dd className="whitespace-pre-wrap text-fg">
            {item.body.trim() || (
              <span className="text-iron/70">(no action recorded)</span>
            )}
          </dd>
        </div>
        {item.dag && (
          <>
            {item.dag.proposalId && (
              <div>
                <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                  From proposal
                </dt>
                <dd className="text-fg">{item.dag.proposalId}</dd>
              </div>
            )}
            <DagList label="Waits on (blockers)" nodes={item.dag.blockers} />
            <DagList
              label="Waited on by (blocking)"
              nodes={item.dag.blocking}
            />
            <DagList
              label="Recovery descendants"
              nodes={item.dag.descendants}
            />
          </>
        )}
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Last updated
          </dt>
          <dd className="text-fg">{formatTime(item.at)}</dd>
        </div>
      </dl>
    </main>
  </div>
)

// ---- Page ----

export const ActionQueuePage = () => {
  const { items, error } = useActionQueue()
  const [query, setQuery] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) =>
        i.id.toLowerCase().includes(q) ||
        i.title.toLowerCase().includes(q) ||
        i.body.toLowerCase().includes(q) ||
        i.kind.toLowerCase().includes(q),
    )
  }, [items, query])

  const selected =
    filtered.find((i) => i.id === selectedId) ?? filtered[0] ?? null
  const empty = items.length === 0
  const noMatches = !empty && filtered.length === 0

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg">
      <aside className="flex w-80 shrink-0 flex-col border-r border-iron/30">
        <header className="border-b border-iron/30 px-4 py-3">
          <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
            Action queue
          </h1>
          <p className="mt-1 font-mono text-[10px] text-iron">
            {items.length} item{items.length === 1 ? '' : 's'}
          </p>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search action queue"
            data-testid="inbox-search"
            className="mt-2 w-full border border-iron/30 bg-bg px-2 py-1 font-mono text-[12px] text-fg placeholder:text-iron/40 focus:outline-none focus:ring-1 focus:ring-iron/50"
          />
        </header>

        <div className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[11px] text-iron/50">
              {query.trim() ? 'No matches.' : 'No items.'}
            </p>
          ) : (
            <ul>
              {filtered.map((item) => (
                <ActionQueueRow
                  key={item.id}
                  item={item}
                  active={item.id === (selected?.id ?? null)}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {error ? (
          <div className="border-t border-iron/40 bg-iron/10 px-4 py-1.5 font-mono text-[10px] text-iron">
            {error}
          </div>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {empty && error ? (
          <ApiErrorPanel error={error} />
        ) : empty ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="font-mono text-[12px] text-iron">
              No items. Inbox alerts appear here when tasks need operator attention.
            </div>
          </div>
        ) : noMatches ? (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            No matches.
          </div>
        ) : selected ? (
          <ActionQueueDetail key={selected.id} item={selected} />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            Select an item
          </div>
        )}
      </section>
    </div>
  )
}
