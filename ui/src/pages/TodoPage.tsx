import { useEffect, useMemo, useState } from 'react'
import { useTodo } from '../hooks/useTodo'
import type { StaleWorktree } from '../lib/api'
import { formatRelativeAgeFromHours } from '../lib/time'
import type { DraftFeature } from '../lib/types'

const shortId = (id: string): string => id.slice(0, 8)

const draftLabel = (d: DraftFeature): string =>
  d.goal.trim() || '(no goal)'

type InboxItem =
  | { kind: 'draft'; id: string; draft: DraftFeature }
  | { kind: 'stale'; id: string; worktree: StaleWorktree }

const itemKey = (item: InboxItem): string =>
  item.kind === 'draft' ? `draft:${item.id}` : `stale:${item.id}`

const formatTime = (ts: number): string => {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString()
}

type BucketKey = 'today' | 'yesterday' | 'this_week' | 'older'

const BUCKET_ORDER: BucketKey[] = ['today', 'yesterday', 'this_week', 'older']

const BUCKET_LABEL: Record<BucketKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  older: 'Older',
}

const itemTimestamp = (item: InboxItem): number => {
  if (item.kind === 'draft') return item.draft.updatedAt
  const t = Date.parse(item.worktree.updatedAt)
  return Number.isNaN(t) ? 0 : t
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const bucketFor = (ts: number, now: number): BucketKey => {
  if (!ts) return 'older'
  const today = startOfDay(now)
  const yesterday = today - 86_400_000
  const weekStart = today - 6 * 86_400_000
  if (ts >= today) return 'today'
  if (ts >= yesterday) return 'yesterday'
  if (ts >= weekStart) return 'this_week'
  return 'older'
}

interface InboxRowProps {
  item: InboxItem
  active: boolean
  onSelect: () => void
}

const InboxRow = ({ item, active, onSelect }: InboxRowProps) => {
  const baseClass = [
    'cursor-pointer border-l-2 px-3 py-2 transition-colors',
    active
      ? 'border-fg bg-iron/20'
      : 'border-transparent hover:bg-iron/10',
  ].join(' ')

  if (item.kind === 'draft') {
    const d = item.draft
    return (
      <li className={baseClass} onClick={onSelect}>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] uppercase text-iron">
            {shortId(d.id)}
          </span>
          <span className="ml-auto font-mono text-[9px] uppercase text-iron/80">
            {d.source}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[12px] text-fg">
          {draftLabel(d)}
        </div>
        <div className="mt-1 font-mono text-[9px] uppercase text-iron/80">
          draft · acceptance {d.acceptanceCount}
        </div>
      </li>
    )
  }

  const w = item.worktree
  return (
    <li className={baseClass} onClick={onSelect}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase text-iron">
          {shortId(w.taskId)}
        </span>
        <span className="ml-auto font-mono text-[9px] uppercase text-iron/80">
          {formatRelativeAgeFromHours(w.ageHours)}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[12px] text-fg">
        Stale worktree
      </div>
      <div className="mt-1 font-mono text-[9px] uppercase text-iron/80">
        stale · {w.status}
      </div>
    </li>
  )
}

interface DraftDetailProps {
  draft: DraftFeature
}

const DraftDetail = ({ draft }: DraftDetailProps) => {
  const refineCommand = `/mars:next ${draft.id}`
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(refineCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
  <div className="flex h-full flex-col overflow-auto">
    <header className="border-b border-iron/30 px-6 py-4">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] uppercase text-iron">
          {shortId(draft.id)}
        </span>
        <span className="font-mono text-[10px] uppercase text-iron/80">
          {draft.source}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase text-iron/80">
          updated {formatTime(draft.updatedAt)}
        </span>
      </div>
      <h2 className="mt-2 font-mono text-[15px] text-fg">
        {draftLabel(draft)}
      </h2>
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
  </div>
  )
}

interface StaleDetailProps {
  worktree: StaleWorktree
}

const StaleDetail = ({ worktree }: StaleDetailProps) => (
  <div className="flex h-full flex-col overflow-auto">
    <header className="border-b border-iron/30 px-6 py-4">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] uppercase text-iron">
          {shortId(worktree.taskId)}
        </span>
        <span className="font-mono text-[10px] uppercase text-iron/80">
          stale worktree
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase text-iron/80">
          {formatRelativeAgeFromHours(worktree.ageHours)} old
        </span>
      </div>
      <h2 className="mt-2 font-mono text-[15px] text-fg">
        Stale worktree {shortId(worktree.taskId)}
      </h2>
    </header>

    <main className="flex-1 px-6 py-4">
      <dl className="flex flex-col gap-4 font-mono text-[12px]">
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
      </dl>
    </main>
  </div>
)

export const TodoPage = () => {
  const { drafts, staleWorktrees, error } = useTodo()

  const items = useMemo<InboxItem[]>(() => {
    const draftItems: InboxItem[] = drafts.map((d) => ({
      kind: 'draft',
      id: d.id,
      draft: d,
    }))
    const staleItems: InboxItem[] = staleWorktrees.map((w) => ({
      kind: 'stale',
      id: w.taskId,
      worktree: w,
    }))
    return [...draftItems, ...staleItems]
  }, [drafts, staleWorktrees])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<BucketKey>>(
    () => new Set(),
  )

  const groupedBuckets = useMemo(() => {
    const now = Date.now()
    const map = new Map<BucketKey, InboxItem[]>()
    for (const item of items) {
      const b = bucketFor(itemTimestamp(item), now)
      const arr = map.get(b) ?? []
      arr.push(item)
      map.set(b, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => itemTimestamp(b) - itemTimestamp(a))
    }
    return BUCKET_ORDER.flatMap((key) => {
      const arr = map.get(key)
      return arr && arr.length > 0 ? [{ key, items: arr }] : []
    })
  }, [items])

  const toggleBucket = (key: BucketKey) => {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  useEffect(() => {
    if (items.length === 0) {
      setSelectedKey(null)
      return
    }
    if (!selectedKey || !items.some((i) => itemKey(i) === selectedKey)) {
      setSelectedKey(itemKey(items[0]))
    }
  }, [items, selectedKey])

  const selected =
    items.find((i) => itemKey(i) === selectedKey) ?? null

  const empty = items.length === 0

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg">
      <aside className="flex w-80 shrink-0 flex-col border-r border-iron/30">
        <header className="border-b border-iron/30 px-4 py-3">
          <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
            Todo
          </h1>
          <p className="mt-1 font-mono text-[10px] text-iron">
            {drafts.length} draft{drafts.length === 1 ? '' : 's'} ·{' '}
            {staleWorktrees.length} stale
          </p>
          {groupedBuckets.length > 0 ? (
            <p className="mt-1 font-mono text-[10px] text-iron">
              {groupedBuckets
                .map(
                  ({ key, items: bucketItems }) =>
                    `${BUCKET_LABEL[key].toLowerCase()} ${bucketItems.length}`,
                )
                .join(' · ')}
            </p>
          ) : null}
        </header>
        <ul className="flex-1 overflow-auto">
          {groupedBuckets.map(({ key, items: bucketItems }) => {
            const collapsed = collapsedBuckets.has(key)
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => toggleBucket(key)}
                  className="flex w-full items-center gap-2 border-b border-iron/20 bg-iron/5 px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-iron hover:bg-iron/10"
                  aria-expanded={!collapsed}
                >
                  <span className="inline-block w-3 text-iron/80">
                    {collapsed ? '▸' : '▾'}
                  </span>
                  <span>{BUCKET_LABEL[key]}</span>
                  <span className="ml-auto text-iron/70">
                    {bucketItems.length}
                  </span>
                </button>
                {collapsed ? null : (
                  <ul>
                    {bucketItems.map((item) => (
                      <InboxRow
                        key={itemKey(item)}
                        item={item}
                        active={itemKey(item) === selectedKey}
                        onSelect={() => setSelectedKey(itemKey(item))}
                      />
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
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
              Nothing to refine. Create a draft with{' '}
              <code className="rounded bg-iron/20 px-1">
                mars idea add "&lt;goal&gt;"
              </code>{' '}
              or run{' '}
              <code className="rounded bg-iron/20 px-1">
                /mars:next
              </code>{' '}
              to start one from scratch.
            </div>
          </div>
        ) : selected?.kind === 'draft' ? (
          <DraftDetail draft={selected.draft} />
        ) : selected?.kind === 'stale' ? (
          <StaleDetail worktree={selected.worktree} />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            Select an item
          </div>
        )}
      </section>
    </div>
  )
}
