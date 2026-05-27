import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { invokeAction } from '@/shared/api'
import type { ActionDescriptor, ActionQueueItem, DagNode } from '@/shared/schemas'

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
  'stale-worktree': 'stale wt',
  'draft-proposal': 'draft',
}

const ACK_STATE_LABEL: Record<'ack' | 'resolved' | 'dismissed', string> = {
  ack: 'acknowledged',
  resolved: 'resolved',
  dismissed: 'dismissed',
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
      <div className="mt-1 break-words font-mono text-[12px] text-fg">
        {item.title || '(no title)'}
      </div>
      <div className="mt-1 font-mono text-[10px] text-iron/70">
        {formatTime(item.at)}
        {item.ackState !== null ? ` · ${ACK_STATE_LABEL[item.ackState]}` : ''}
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

// ---- Action bar ----

interface ActionBarProps {
  item: ActionQueueItem
}

// Op string used in two places inside ActionBar; defined once to avoid drift.
const INVESTIGATE_OP = 'investigate'

/**
 * Renders one button per recovery action on the row. Clicking proxies the
 * action's `op` to the daemon (via `/api/actions`). `needsConfirm` actions
 * prompt first; destructive ops are styled accordingly. The `shape` op has no
 * daemon verb — it renders as a guidance chip showing the skill to run.
 *
 * For stale-worktree rows where `empty === true` the Investigate action is
 * suppressed (nothing to analyse in an empty worktree).
 */
const ActionBar = ({ item }: ActionBarProps) => {
  const qc = useQueryClient()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: ({ action }: { action: ActionDescriptor }) => {
      // Process-level ops (restart-daemon) carry no entity id.
      const entityId = action.op === 'restart-daemon' ? undefined : item.entityId
      return invokeAction(action.op, entityId)
    },
    onMutate: () => setErrorMsg(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['action-queue'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['progress'] })
    },
    onError: (err) => setErrorMsg((err as Error).message),
  })

  // Gate Investigate out for empty stale worktrees — there is nothing to analyse.
  const visibleActions =
    item.kind === 'stale-worktree' && item.staleWorktreeDetail?.empty === true
      ? item.actions.filter((a) => a.op !== INVESTIGATE_OP)
      : item.actions

  if (visibleActions.length === 0) return null

  // Show a specific label while the Investigate (Haiku) call is in-flight.
  const isInvestigating =
    mutation.isPending && mutation.variables?.action.op === INVESTIGATE_OP

  const run = (action: ActionDescriptor) => {
    if (mutation.isPending) return
    if (
      action.needsConfirm &&
      !window.confirm(`${action.label}: ${item.entityId}. Proceed?`)
    ) {
      return
    }
    mutation.mutate({ action })
  }

  return (
    <div>
      <dt className="mb-2 text-[10px] uppercase tracking-wider text-iron">
        Recovery
      </dt>
      <dd className="flex flex-wrap gap-2">
        {visibleActions.map((action) =>
          action.op === 'shape' ? (
            <span
              key={action.id}
              className="border border-iron/30 px-3 py-1.5 font-mono text-[11px] text-iron"
            >
              {action.label}
              {action.hint ? ` · ${action.hint}` : ''}
            </span>
          ) : (
            <button
              key={action.id}
              type="button"
              disabled={mutation.isPending}
              onClick={() => run(action)}
              className={[
                'border px-3 py-1.5 font-mono text-[11px] uppercase transition-colors disabled:opacity-50',
                action.needsConfirm
                  ? 'border-[#ff4f4f]/50 text-[#ff4f4f] hover:bg-[#ff4f4f]/10'
                  : 'border-iron/40 text-fg hover:bg-iron/20',
              ].join(' ')}
            >
              {action.op === INVESTIGATE_OP && isInvestigating
                ? 'Investigating…'
                : action.label}
            </button>
          ),
        )}
      </dd>
      {errorMsg ? (
        <p className="mt-2 font-mono text-[10px] text-[#ff4f4f]">{errorMsg}</p>
      ) : null}
    </div>
  )
}

// ---- Detail panel ----

interface DetailProps {
  item: ActionQueueItem
}

const ActionQueueDetail = ({ item }: DetailProps) => {
  return (
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
          <ActionBar item={item} />
          {item.kind === 'stale-worktree' && (
            <>
              <div>
                <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                  Task prompt
                </dt>
                <dd className="whitespace-pre-wrap text-fg">
                  {item.staleWorktreeDetail?.prompt ?? (
                    <span className="text-iron/70">absent (no matching task)</span>
                  )}
                </dd>
              </div>
              {item.staleWorktreeDetail && (
                <>
                  <div>
                    <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                      Status · Age · Branch
                    </dt>
                    <dd className="text-fg">
                      <span>{item.staleWorktreeDetail.status}</span>
                      {' · '}
                      <span>{item.staleWorktreeDetail.ageHours.toFixed(1)}h</span>
                      {' · '}
                      <span>{item.staleWorktreeDetail.branch ?? '—'}</span>
                    </dd>
                  </div>
                  <div>
                    <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                      Investigation
                    </dt>
                    <dd>
                      {item.staleWorktreeDetail.investigation ? (
                        <>
                          <p className="mb-1 text-[10px] text-iron/60">
                            {formatTime(item.staleWorktreeDetail.updatedAt)}
                          </p>
                          <p className="whitespace-pre-wrap text-fg">
                            {item.staleWorktreeDetail.investigation}
                          </p>
                        </>
                      ) : item.staleWorktreeDetail.empty ? null : (
                        <span className="text-iron/70">
                          None yet — use Investigate to analyse this worktree.
                        </span>
                      )}
                    </dd>
                  </div>
                </>
              )}
            </>
          )}
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
}

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
