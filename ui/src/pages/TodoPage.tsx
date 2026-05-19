import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTodo } from '@/hooks/useTodo'
import { dismissTodoItem, type StaleWorktree, type TodoPayload } from '@/shared/api'
import type { DraftFeature } from '@/shared/types'
import { formatRelativeAgeFromHours } from '@/shared/time'

// ---- Types ----

type AlertItem = { kind: 'stale'; id: string; worktree: StaleWorktree }
type IdeaItem = { kind: 'draft'; id: string; draft: DraftFeature }
type SidebarItem = AlertItem | IdeaItem

const itemKey = (item: SidebarItem): string => `${item.kind}:${item.id}`

// ---- Alert Row ----

interface AlertRowProps {
  item: AlertItem
  active: boolean
  onSelect: () => void
  onDismiss: () => void
}

const AlertRow = ({ item, active, onSelect, onDismiss }: AlertRowProps) => {
  const baseClass = [
    'cursor-pointer border-l-2 px-3 py-2 transition-colors',
    active ? 'border-fg bg-iron/20' : 'border-transparent hover:bg-iron/10',
  ].join(' ')

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDismiss()
  }

  const w = item.worktree
  return (
    <li className={baseClass} onClick={onSelect}>
      <div className="flex items-baseline gap-2">
        <span className="break-all font-mono text-[10px] uppercase text-iron">
          {w.taskId}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9px] uppercase text-iron/80">
          {formatRelativeAgeFromHours(w.ageHours)}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[12px] text-fg">
        {w.prompt.trim() || 'Stale worktree'}
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[9px] uppercase text-iron/80">
        <span>stale · {w.status}</span>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 text-iron/50 transition-colors hover:text-iron"
        >
          dismiss
        </button>
      </div>
    </li>
  )
}

// ---- Idea Row ----

const draftLabel = (d: DraftFeature): string => d.goal.trim() || '(no goal)'

interface IdeaRowProps {
  item: IdeaItem
  active: boolean
  onSelect: () => void
  onDismiss: () => void
}

const IdeaRow = ({ item, active, onSelect, onDismiss }: IdeaRowProps) => {
  const baseClass = [
    'cursor-pointer border-l-2 px-3 py-2 transition-colors',
    active ? 'border-fg bg-iron/20' : 'border-transparent hover:bg-iron/10',
  ].join(' ')

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDismiss()
  }

  const d = item.draft
  return (
    <li className={baseClass} onClick={onSelect}>
      <div className="flex items-baseline gap-2">
        <span className="break-all font-mono text-[10px] uppercase text-iron">
          {d.id}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9px] uppercase text-iron/80">
          {d.source}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[12px] text-fg">
        {draftLabel(d)}
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[9px] uppercase text-iron/80">
        <span>idea · acceptance {d.acceptanceCount}</span>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 text-iron/50 transition-colors hover:text-iron"
        >
          dismiss
        </button>
      </div>
    </li>
  )
}

// ---- Detail Panels ----

interface StaleDetailProps {
  worktree: StaleWorktree
}

const StaleDetail = ({ worktree }: StaleDetailProps) => (
  <div className="flex h-full flex-col overflow-auto">
    <header className="border-b border-iron/30 px-6 py-4">
      <div className="flex items-baseline gap-3">
        <span className="break-all font-mono text-[11px] uppercase text-iron">
          {worktree.taskId}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-iron/80">
          stale worktree
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase text-iron/80">
          {formatRelativeAgeFromHours(worktree.ageHours)} old
        </span>
      </div>
      <h2 className="mt-2 break-all font-mono text-[15px] text-fg">
        Stale worktree {worktree.taskId}
      </h2>
    </header>

    <main className="flex-1 px-6 py-4">
      <dl className="flex flex-col gap-4 font-mono text-[12px]">
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Task
          </dt>
          <dd className="whitespace-pre-wrap text-fg">
            {worktree.prompt.trim() || (
              <span className="text-iron/70">(empty)</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Task id
          </dt>
          <dd className="text-fg">{worktree.taskId}</dd>
        </div>
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Status
          </dt>
          <dd className="text-fg">{worktree.status}</dd>
        </div>
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Branch
          </dt>
          <dd className="text-fg">{worktree.branch ?? '—'}</dd>
        </div>
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Age
          </dt>
          <dd className="text-fg">{worktree.ageHours}h</dd>
        </div>
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Updated at
          </dt>
          <dd className="text-fg">{worktree.updatedAt}</dd>
        </div>
        {worktree.blockerTaskId !== null ? (
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Blocked by
            </dt>
            <dd className="text-fg">{worktree.blockerTaskId}</dd>
          </div>
        ) : null}
        {worktree.error !== null ? (
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Error
            </dt>
            <dd className="whitespace-pre-wrap text-fg">{worktree.error}</dd>
          </div>
        ) : null}
      </dl>
    </main>
  </div>
)

const formatTime = (ts: number): string => {
  if (!ts) return ''
  return new Date(ts).toLocaleString()
}

interface IdeaDetailProps {
  draft: DraftFeature
  onDismiss: () => Promise<unknown>
}

const IdeaDetail = ({ draft, onDismiss }: IdeaDetailProps) => {
  const refineCommand = `/mars:chat ${draft.id}`
  const [copied, setCopied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [dismissError, setDismissError] = useState<string | null>(null)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(refineCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  const openConfirm = () => {
    setDismissError(null)
    setConfirmOpen(true)
  }

  const closeConfirm = () => {
    if (dismissing) return
    setConfirmOpen(false)
    setDismissError(null)
  }

  const handleConfirmDismiss = async () => {
    setDismissing(true)
    setDismissError(null)
    try {
      await onDismiss()
      setConfirmOpen(false)
    } catch (err: unknown) {
      setDismissError(err instanceof Error ? err.message : 'Dismiss failed')
    } finally {
      setDismissing(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="border-b border-iron/30 px-6 py-4">
        <div className="flex items-baseline gap-3">
          <span className="break-all font-mono text-[11px] uppercase text-iron">
            {draft.id}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase text-iron/80">
            {draft.source}
          </span>
          <span className="ml-auto font-mono text-[10px] uppercase text-iron/80">
            updated {formatTime(draft.updatedAt)}
          </span>
        </div>
        <h2 className="mt-2 font-mono text-[15px] text-fg">{draftLabel(draft)}</h2>
        <div className="mt-2 font-mono text-[11px] text-iron">
          Refine:{' '}
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy to clipboard'}
            className="cursor-pointer rounded bg-iron/20 px-1 font-mono text-[11px] text-iron transition-colors hover:bg-iron/30"
          >
            <code>{refineCommand}</code>
            <span className="ml-1 text-[9px] uppercase text-iron/70">
              {copied ? 'copied' : 'copy'}
            </span>
          </button>
        </div>
      </header>

      <main className="flex-1 px-6 py-4">
        <dl className="flex flex-col gap-4 font-mono text-[12px]">
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Story
            </dt>
            <dd className="whitespace-pre-wrap text-fg">
              {draft.story.trim() || (
                <span className="text-iron/70">(empty)</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Technical
            </dt>
            <dd className="whitespace-pre-wrap text-fg">
              {draft.technical.trim() || (
                <span className="text-iron/70">(empty)</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Acceptance
            </dt>
            <dd className="text-fg">{draft.acceptanceCount}</dd>
          </div>
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Status
            </dt>
            <dd className="text-fg">{draft.status}</dd>
          </div>
        </dl>
      </main>

      <footer className="border-t border-iron/30 px-6 py-3">
        <button
          type="button"
          onClick={openConfirm}
          data-testid="idea-detail-dismiss"
          className="rounded border border-iron/40 px-3 py-1 font-mono text-[11px] uppercase text-iron transition-colors hover:bg-iron/10"
        >
          Dismiss proposal
        </button>
      </footer>

      {confirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm dismiss proposal"
          data-testid="idea-dismiss-confirm"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={closeConfirm}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md border border-iron/40 bg-bg p-5 font-mono text-[12px] text-fg shadow-2xl"
          >
            <h3 className="text-[13px] uppercase tracking-wide text-fg">
              Dismiss proposal?
            </h3>
            <p className="mt-2 break-all text-[11px] text-iron">
              {draft.id} — {draftLabel(draft)}
            </p>
            <p className="mt-3 text-[11px] text-iron/80">
              This flips the proposal to <code>dismissed</code>. It is refused
              if any task still depends on this proposal.
            </p>
            {dismissError ? (
              <p
                data-testid="idea-dismiss-error"
                className="mt-3 whitespace-pre-wrap border border-iron/40 bg-iron/10 px-2 py-1 text-[11px] text-iron"
              >
                {dismissError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeConfirm}
                disabled={dismissing}
                className="rounded border border-iron/40 px-3 py-1 text-[11px] uppercase text-iron transition-colors hover:bg-iron/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDismiss}
                disabled={dismissing}
                data-testid="idea-dismiss-confirm-btn"
                className="rounded border border-iron/40 bg-iron/20 px-3 py-1 text-[11px] uppercase text-fg transition-colors hover:bg-iron/30 disabled:opacity-50"
              >
                {dismissing ? 'Dismissing…' : 'Dismiss'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---- Sidebar Section Header ----

interface SectionHeaderProps {
  label: string
  count: number
}

const SectionHeader = ({ label, count }: SectionHeaderProps) => (
  <div className="flex items-center gap-2 border-b border-iron/20 bg-iron/5 px-4 py-1.5">
    <span className="font-mono text-[10px] uppercase tracking-wider text-iron">
      {label}
    </span>
    <span className="ml-auto font-mono text-[10px] text-iron/60">{count}</span>
  </div>
)

// ---- Page ----

export const ActionQueuePage = () => {
  const { staleWorktrees, drafts, error } = useTodo()
  const queryClient = useQueryClient()

  const dismissStaleMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => dismissTodoItem(id, 'stale'),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ['todo'] })
      const prev = queryClient.getQueryData<TodoPayload>(['todo'])
      if (prev) {
        queryClient.setQueryData<TodoPayload>(['todo'], {
          ...prev,
          staleWorktrees: prev.staleWorktrees.filter((w) => w.taskId !== id),
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData<TodoPayload>(['todo'], ctx.prev)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['todo'] })
    },
  })

  const dismissDraftMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => dismissTodoItem(id, 'draft'),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ['todo'] })
      const prev = queryClient.getQueryData<TodoPayload>(['todo'])
      if (prev) {
        queryClient.setQueryData<TodoPayload>(['todo'], {
          ...prev,
          drafts: prev.drafts.filter((d) => d.id !== id),
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData<TodoPayload>(['todo'], ctx.prev)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['todo'] })
    },
  })

  const alertItems = useMemo<AlertItem[]>(
    () =>
      staleWorktrees.map((w) => ({ kind: 'stale', id: w.taskId, worktree: w })),
    [staleWorktrees],
  )

  const ideaItems = useMemo<IdeaItem[]>(
    () => drafts.map((d) => ({ kind: 'draft', id: d.id, draft: d })),
    [drafts],
  )

  const allItems = useMemo<SidebarItem[]>(
    () => [...alertItems, ...ideaItems],
    [alertItems, ideaItems],
  )

  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  useEffect(() => {
    if (allItems.length === 0) {
      setSelectedKey(null)
      return
    }
    if (!selectedKey || !allItems.some((i) => itemKey(i) === selectedKey)) {
      setSelectedKey(itemKey(allItems[0]))
    }
  }, [allItems, selectedKey])

  const selected = allItems.find((i) => itemKey(i) === selectedKey) ?? null
  const empty = allItems.length === 0

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg">
      <aside className="flex w-80 shrink-0 flex-col border-r border-iron/30">
        <header className="border-b border-iron/30 px-4 py-3">
          <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
            Inbox
          </h1>
          <p className="mt-1 font-mono text-[10px] text-iron">
            {staleWorktrees.length} alert
            {staleWorktrees.length === 1 ? '' : 's'} ·{' '}
            {drafts.length} proposal{drafts.length === 1 ? '' : 's'}
          </p>
        </header>

        <div className="flex-1 overflow-auto">
          {/* Alerts section */}
          <SectionHeader label="Alerts" count={alertItems.length} />
          {alertItems.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[11px] text-iron/50">
              No alerts.
            </p>
          ) : (
            <ul>
              {alertItems.map((item) => (
                <AlertRow
                  key={itemKey(item)}
                  item={item}
                  active={itemKey(item) === selectedKey}
                  onSelect={() => setSelectedKey(itemKey(item))}
                  onDismiss={() => dismissStaleMutation.mutate({ id: item.id })}
                />
              ))}
            </ul>
          )}

          {/* Proposals section */}
          <SectionHeader label="Proposals" count={ideaItems.length} />
          {ideaItems.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[11px] text-iron/50">
              No proposals.
            </p>
          ) : (
            <ul>
              {ideaItems.map((item) => (
                <IdeaRow
                  key={itemKey(item)}
                  item={item}
                  active={itemKey(item) === selectedKey}
                  onSelect={() => setSelectedKey(itemKey(item))}
                  onDismiss={() => dismissDraftMutation.mutate({ id: item.id })}
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
        {empty ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="font-mono text-[12px] text-iron">
              No items. Alerts appear when worktrees go stale; proposals appear
              when drafts are added.
            </div>
          </div>
        ) : selected?.kind === 'stale' ? (
          <StaleDetail worktree={selected.worktree} />
        ) : selected?.kind === 'draft' ? (
          <IdeaDetail
            key={selected.draft.id}
            draft={selected.draft}
            onDismiss={() =>
              dismissDraftMutation.mutateAsync({ id: selected.draft.id })
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            Select an item
          </div>
        )}
      </section>
    </div>
  )
}
