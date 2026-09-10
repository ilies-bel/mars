import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ProposalDetail, ProgressTask } from '@/shared/schemas'
import { CopyButton } from '@/components/CopyButton'
import { CollapsibleSection } from '@/components/CollapsibleSection'
import { ProposalActionRow } from '@/components/ProposalActionRow'
import { formatAbsoluteDate } from '@/shared/time'
import { taskHash } from '@/shared/routing'
import { patchProposalField, type ProposalField } from '@/shared/api'
import { stripMarkdown } from '@/shared/stripMarkdown'
import { taskTitle } from '@/shared/promptTitle'

export type { ProposalActionRowProps } from '@/components/ProposalActionRow'

/**
 * Generic action-button state machine used across proposal action surfaces.
 *
 * `T` merges additional fields into the `done` variant (e.g. `{ taskId: string }`).
 * Defaults to an empty intersection so the plain `done` variant carries only `kind`.
 */
export type ActionButtonState<T = Record<never, never>> =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | ({ kind: 'done' } & T)
  | { kind: 'error'; message: string }

interface ProposalDetailDrawerProps {
  /** Full proposal record sourced from GET /api/proposals/:id. */
  proposal: ProposalDetail
  /** Clears the `#/proposal/<id>` hash so the drawer closes. */
  onClose: () => void
  /**
   * Task list already loaded by the Progress tab. Used to show child tasks
   * when the proposal status is `sliced`. No new HTTP request is made.
   */
  tasks?: ProgressTask[]
  /**
   * Authoritative flag for whether a mockup file exists for this proposal.
   * The drawer uses this value directly — no HEAD probe is issued. The parent
   * is responsible for deriving this from the proposal record (e.g. a
   * `mockupReady` field) so no speculative network request is made on open.
   */
  initialMockupExists?: boolean
  /**
   * When provided, the user stories section renders inline management controls
   * (add / edit / remove). Omit to show the section in read-only mode.
   *
   * Used by consumer slice 3 ("Add user story management UI in
   * ProposalDetailDrawer") which wires these to PATCH /api/proposals/:id/user-stories.
   */
  onAddUserStory?: (story: string) => Promise<void>
  onRemoveUserStory?: (index: number) => Promise<void>
  onEditUserStory?: (index: number, newText: string) => Promise<void>
}

/**
 * Status-badge colour pairs for the proposal lifecycle. The class shape
 * mirrors the task `StatusChip` legend (rounded, mono, uppercase) so the two
 * drawers read as one visual family. Unknown statuses fall back to the neutral
 * iron treatment rather than rendering nothing.
 */
const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-primary/10 text-muted-foreground',
  'prd-ready': 'bg-warn/15 text-warn',
  sliced: 'bg-warn/15 text-warn',
  dismissed: 'bg-primary/10 text-muted-foreground line-through',
}

const badgeClass = (status: string): string =>
  STATUS_BADGE[status] ?? 'bg-primary/10 text-muted-foreground'

/**
 * Copy-pasteable CLI commands shown in the drawer for each proposal status.
 * Informational only — separate action buttons handle mutations.
 */
const STATUS_CLI_VERBS: Record<string, string[]> = {
  draft: ['promote', 'mockup', 'show'],
  'prd-ready': ['slice', 'show'],
  sliced: ['show'],
  dismissed: ['show'],
}

/**
 * A collapsible proposal body section with optional "Read more / Show less"
 * clamping for long text. Open by default so the content is visible on first
 * paint — operators can close a section they don't need.
 *
 * Called four times (problem / solution / outOfScope / notes), satisfying the
 * multi-caller requirement and keeping clamp logic in one place.
 *
 * When `editable` is true and `proposalId` + `field` are supplied, the section
 * gains an inline edit mode: hovering reveals a ✎ affordance, clicking switches
 * the `<p>` to a `<textarea>`. Ctrl+Enter or the Save button commits the change
 * via `patchProposalField`; Escape or Cancel reverts without saving.
 */
export const BodySection = ({
  label,
  text,
  testId,
  maxLines = 8,
  onSave,
  editable,
  field,
  proposalId,
  onSaved,
}: {
  label: string
  text: string
  testId: string
  maxLines?: number
  children?: ReactNode
  /**
   * Legacy prop — accepted for backwards compatibility; has no effect.
   * Consumer slice 5 uses `editable` / `field` / `proposalId` instead.
   */
  onSave?: (newText: string) => Promise<void>
  /** When true, a ✎ affordance appears on hover and the section is editable. */
  editable?: boolean
  /** The proposal field name sent to `patchProposalField` on save. */
  field?: ProposalField
  /** Proposal id forwarded to `patchProposalField`. */
  proposalId?: string
  /** Called after a successful save with the field name and new value. */
  onSaved?: (field: string, value: string) => void
}) => {
  void onSave

  type EditState = 'view' | 'editing' | 'saving' | 'error'
  const [editState, setEditState] = useState<EditState>('view')
  const [editText, setEditText] = useState('')
  const [savedValue, setSavedValue] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [expanded, setExpanded] = useState(false)

  const displayedText = savedValue ?? text
  const lineCount = displayedText.split('\n').length
  const isLong = lineCount > maxLines

  const isEditing = editState === 'editing' || editState === 'saving' || editState === 'error'

  const handleEdit = () => {
    if (!editable) return
    setEditText(savedValue ?? text)
    setEditState('editing')
  }

  const handleCancel = () => {
    setEditState('view')
    setErrorMessage('')
  }

  const handleSave = async () => {
    if (editState === 'saving' || !proposalId || !field) return
    setEditState('saving')
    try {
      await patchProposalField(proposalId, field, editText)
      setSavedValue(editText)
      setEditState('view')
      onSaved?.(field, editText)
    } catch (err) {
      setEditState('error')
      setErrorMessage((err as Error).message)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      void handleSave()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }

  return (
    <section
      data-testid={testId}
      className={`${editable ? 'group ' : ''}border-b border-border px-4 py-3`}
    >
      <CollapsibleSection label={label} defaultOpen>
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={editState === 'saving'}
              autoFocus
              aria-label={`Edit ${label}`}
              className="min-h-[80px] w-full resize-y rounded border border-border bg-background px-2 py-1 text-body text-foreground disabled:opacity-50"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { void handleSave() }}
                disabled={editState === 'saving'}
                className="rounded border border-border px-2 py-0.5 text-body text-muted-foreground hover:bg-foreground/5 disabled:opacity-50"
              >
                {editState === 'saving' ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={editState === 'saving'}
                className="rounded border border-border px-2 py-0.5 text-body text-muted-foreground hover:bg-foreground/5 disabled:opacity-50"
              >
                Cancel
              </button>
              {editState === 'error' && (
                <span className="text-micro text-destructive">{errorMessage}</span>
              )}
            </div>
          </div>
        ) : (
          <div className={editable ? 'relative' : undefined}>
            {editable && (
              <button
                type="button"
                onClick={handleEdit}
                aria-label={`Edit ${label}`}
                className="absolute right-0 top-0 rounded px-1 py-0.5 text-body text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/5 group-hover:opacity-100"
              >
                ✎
              </button>
            )}
            <p
              className="whitespace-pre-wrap text-body leading-relaxed text-foreground"
              style={
                isLong && !expanded
                  ? {
                      display: '-webkit-box',
                      WebkitLineClamp: maxLines,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }
                  : undefined
              }
            >
              {stripMarkdown(displayedText)}
            </p>
            {isLong ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1.5 text-micro text-muted-foreground underline hover:text-foreground"
              >
                {expanded ? 'Show less' : 'Read more'}
              </button>
            ) : null}
          </div>
        )}
      </CollapsibleSection>
    </section>
  )
}

const BASE = typeof import.meta !== 'undefined' && import.meta.env
  ? (import.meta.env.VITE_API_BASE ?? '')
  : ''

/**
 * PATCH /api/proposals/:id/user-stories — add, edit, or remove a single
 * user story entry.
 *
 * Exported so consumer slice 3 ("Add user story management UI in
 * ProposalDetailDrawer") can call this from its inline add/edit/remove
 * controls without duplicating the fetch boilerplate or the error-extraction
 * pattern used by `postAction`.
 *
 * The server endpoint receives `{ op, story?, index? }` and persists the
 * change via the `proposal_user_stories` table.
 */
export async function patchProposalUserStory(
  proposalId: string,
  op: 'add' | 'edit' | 'remove',
  payload: { story?: string; index?: number },
): Promise<void> {
  const r = await fetch(
    `${BASE}/api/proposals/${encodeURIComponent(proposalId)}/user-stories`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...payload }),
    },
  )
  if (!r.ok) {
    let message = `PATCH /api/proposals/${proposalId}/user-stories → ${r.status}`
    try {
      const body = await r.json() as { error?: string }
      if (typeof body.error === 'string' && body.error.length > 0) message = body.error
    } catch { /* ignore JSON parse errors */ }
    throw new Error(message)
  }
}

/**
 * Proposal detail drawer — renders at `#/proposal/<id>`.
 *
 * Shows the full proposal body (title, problem, solution, user stories,
 * outOfScope, notes) plus an action row with Promote, Grill, and Dismiss
 * buttons wired to the existing server surfaces.
 */
export const ProposalDetailDrawer = ({
  proposal,
  onClose,
  tasks = [],
  initialMockupExists = false,
  // Story-management callbacks (consumer slice 3). Destructured here so
  // TypeScript confirms they satisfy ProposalDetailDrawerProps; wiring to
  // the user stories section UI is consumer slice 3's responsibility.
  onAddUserStory: _onAddUserStory,
  onRemoveUserStory: _onRemoveUserStory,
  onEditUserStory: _onEditUserStory,
}: ProposalDetailDrawerProps) => {
  const childTasks = proposal.status === 'sliced'
    ? tasks.filter((t) => t.parentProposalId === proposal.id)
    : []
  const drawerRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)

  const [mockupExists] = useState<boolean>(initialMockupExists)

  /**
   * Initiates the exit animation (180 ms) then calls the onClose prop.
   * All close triggers (button, scrim, Escape) funnel through here so the
   * transition always plays before the parent unmounts the drawer.
   */
  const handleClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose(), 180)
  }, [onClose])

  // On open: save the previously focused element and move focus into the drawer.
  // On close (cleanup): restore focus to where it was.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    drawerRef.current?.focus()
    return () => {
      prev?.focus?.()
    }
  }, [])

  // Escape-to-close + Tab focus trap.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
        return
      }
      if (e.key === 'Tab') {
        const container = drawerRef.current
        if (!container) return
        const focusable = [
          ...container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
        if (focusable.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        if (e.shiftKey) {
          if (document.activeElement === first || document.activeElement === container) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClose])

  // Derive the mockup URL for the header link. No HEAD probe is issued —
  // `mockupExists` is seeded by `initialMockupExists` and stays fixed for
  // the lifetime of the drawer to avoid speculative 404 requests.
  const mockupUrl = useMemo(() => `${BASE}/mockups/${encodeURIComponent(proposal.id)}.html`, [proposal.id])

  const isDraft = proposal.status === 'draft'

  // Local story list — mutated by add/remove without a full page reload.
  const [stories, setStories] = useState(proposal.userStories)
  const [addingStory, setAddingStory] = useState(false)
  const [newStoryText, setNewStoryText] = useState('')
  const [storyOpState, setStoryOpState] = useState<'idle' | 'pending' | 'error'>('idle')
  const [storyOpError, setStoryOpError] = useState<string | null>(null)

  // A machine-generated proposal is authored by the agent that is also its
  // source, so rendering both spelled the same word twice in two casings
  // ("FAILURE-REFLECTOR failure-reflector"). Show the author only when it
  // says something the source chip does not — i.e. for a human author.
  const authorAddsInfo =
    proposal.author != null &&
    proposal.author.name.trim().toLowerCase() !== proposal.source.trim().toLowerCase()

  // Format createdAt timestamp as an unambiguous absolute date.
  const createdLabel = proposal.createdAt ? formatAbsoluteDate(proposal.createdAt) : null

  return (
    <>
      {/* Scrim — sits at z-40 (below the drawer's z-50) so clicks outside dismiss the panel */}
      <div
        data-testid="proposal-detail-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 bg-foreground/40"
        onClick={handleClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Proposal detail"
        data-testid="proposal-detail-drawer"
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        className="drawer-panel fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-border bg-background shadow-2xl outline-none"
      >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h2
            data-testid="proposal-detail-title"
            className="break-words text-title text-foreground"
          >
            {proposal.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="proposal-detail-status"
              aria-label={`status ${proposal.status}`}
              className={`eyebrow inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${badgeClass( proposal.status, )} text-muted-foreground`}
            >
              {proposal.status}
            </span>
            <span
              data-testid="proposal-detail-source"
              className="eyebrow text-muted-foreground"
            >
              {proposal.source}
            </span>
            {authorAddsInfo && (
              <span
                data-testid="proposal-detail-author"
                className="text-micro text-muted-foreground"
              >
                {proposal.author!.name}
              </span>
            )}
            {createdLabel && (
              <span
                data-testid="proposal-detail-created"
                className="text-micro text-muted-foreground"
              >
                {createdLabel}
              </span>
            )}
            {proposal.userStories.length > 0 && (
              <span
                data-testid="proposal-detail-story-count"
                className="eyebrow text-muted-foreground"
              >
                {proposal.userStories.length}{' '}
                {proposal.userStories.length === 1 ? 'story' : 'stories'}
              </span>
            )}
          </div>
          {/* Mockup chip — promoted to the header so it is visible for all
              proposal statuses, not just draft. One quiet affordance, not a
              notification stream. */}
          {mockupExists && (
            <a
              href={mockupUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-view-mockup"
              className="inline-flex w-fit items-center gap-1 rounded border border-border px-2 py-0.5 text-body text-muted-foreground hover:bg-foreground/5"
            >
              View mockup ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close proposal detail"
          data-testid="proposal-detail-close"
          className="shrink-0 rounded border border-border px-2 py-0.5 text-body text-muted-foreground hover:bg-foreground/5"
        >
          Close
        </button>
      </header>

      {/* Action row — Promote / Grill / Mockup / Implement live / Dismiss — visible for draft.
          Promote and Implement live are disabled when both problem and solution are blank. */}
      {isDraft && (
        <ProposalActionRow
          proposalId={proposal.id}
          status={proposal.status}
          bodyEmpty={!proposal.problem.trim() && !proposal.solution.trim()}
        />
      )}

      {/* Scrollable body — problem, solution, user stories, outOfScope, notes, sliced tasks */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {proposal.problem.trim() ? (
          <BodySection
            label="Problem"
            text={proposal.problem}
            testId="proposal-detail-problem"
            editable={isDraft}
            field="problem"
            proposalId={proposal.id}
          />
        ) : null}

        {proposal.solution.trim() ? (
          <BodySection
            label="Solution"
            text={proposal.solution}
            testId="proposal-detail-solution"
            editable={isDraft}
            field="solution"
            proposalId={proposal.id}
          />
        ) : null}

        {(stories.length > 0 || isDraft) ? (
          <section
            data-testid="proposal-detail-stories"
            className="border-b border-border px-4 py-3"
          >
            <CollapsibleSection label="User stories" defaultOpen>
              {stories.length > 0 ? (
                <ol className="flex flex-col gap-1.5">
                  {stories.map((story, idx) => (
                    <li key={idx} className="group flex gap-2 text-body text-foreground">
                      <span className="shrink-0 text-muted-foreground">{idx + 1}.</span>
                      <span className="flex-1">{story}</span>
                      {isDraft ? (
                        <button
                          type="button"
                          aria-label={`Remove story ${idx + 1}`}
                          disabled={storyOpState === 'pending'}
                          className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground disabled:opacity-50"
                          onClick={async () => {
                            setStoryOpState('pending')
                            setStoryOpError(null)
                            try {
                              await patchProposalUserStory(proposal.id, 'remove', { index: idx })
                              setStories((prev) => prev.filter((_, i) => i !== idx))
                              setStoryOpState('idle')
                            } catch (err) {
                              setStoryOpState('error')
                              setStoryOpError(err instanceof Error ? err.message : 'Failed to remove story')
                            }
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {isDraft ? (
                <div className="mt-2">
                  {storyOpState === 'error' && storyOpError ? (
                    <p className="mb-1.5 text-micro text-error">{storyOpError}</p>
                  ) : null}
                  {!addingStory ? (
                    <button
                      type="button"
                      data-testid="btn-add-story"
                      className="text-body text-highlight underline hover:text-foreground"
                      onClick={() => setAddingStory(true)}
                    >
                      Add story
                    </button>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <input
                        type="text"
                        value={newStoryText}
                        onChange={(e) => setNewStoryText(e.target.value)}
                        placeholder="As a user, I want…"
                        className="rounded border border-border bg-background px-2 py-1 text-body text-foreground"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={storyOpState === 'pending' || !newStoryText.trim()}
                          className="text-body text-highlight underline hover:text-foreground disabled:opacity-50"
                          onClick={async () => {
                            const trimmed = newStoryText.trim()
                            if (!trimmed) return
                            setStoryOpState('pending')
                            setStoryOpError(null)
                            try {
                              await patchProposalUserStory(proposal.id, 'add', { story: trimmed })
                              setStories((prev) => [...prev, trimmed])
                              setNewStoryText('')
                              setAddingStory(false)
                              setStoryOpState('idle')
                            } catch (err) {
                              setStoryOpState('error')
                              setStoryOpError(err instanceof Error ? err.message : 'Failed to add story')
                            }
                          }}
                        >
                          Submit
                        </button>
                        <button
                          type="button"
                          className="text-body text-highlight underline hover:text-foreground"
                          onClick={() => {
                            setAddingStory(false)
                            setNewStoryText('')
                            setStoryOpError(null)
                            setStoryOpState('idle')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </CollapsibleSection>
          </section>
        ) : null}

        {proposal.outOfScope.trim() ? (
          <BodySection
            label="Out of scope"
            text={proposal.outOfScope}
            testId="proposal-detail-out-of-scope"
            editable={isDraft}
            field="out-of-scope"
            proposalId={proposal.id}
          />
        ) : null}

        {proposal.notes.trim() ? (
          <BodySection
            label="Notes"
            text={proposal.notes}
            testId="proposal-detail-notes"
            editable={isDraft}
            field="notes"
            proposalId={proposal.id}
          />
        ) : null}

        {childTasks.length > 0 ? (
          <section
            data-testid="sliced-tasks"
            className="flex flex-col gap-2 border-b border-border px-4 py-3"
          >
            <h3 className="eyebrow text-muted-foreground">
              Sliced tasks
            </h3>
            <ul className="flex flex-col gap-1.5">
              {childTasks.map((task) => (
                <li key={task.id}>
                  <a
                    href={taskHash(task.id)}
                    className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-body transition-colors hover:bg-foreground/5"
                  >
                    <span className="shrink-0 font-mono text-micro text-muted-foreground">{task.id}</span>
                    <span
                      className={`eyebrow inline-flex shrink-0 items-center rounded px-1 py-0.5 ${badgeClass(task.status)} text-muted-foreground`}
                    >
                      {task.status}
                    </span>
                    <span className="min-w-0 truncate text-foreground">
                      {taskTitle(task)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* CLI commands — read-only, status-appropriate, copy-to-clipboard.
          Collapsed behind a <details> so the drawer footer stays compact. */}
      <section className="border-t border-border px-4 py-3">
        <details>
          <summary className="cursor-pointer select-none text-body text-muted-foreground hover:text-foreground">
            Copy command <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {(STATUS_CLI_VERBS[proposal.status] ?? ['show']).map((verb) => {
              const cmd = `mars proposal ${verb} ${proposal.id}`
              return (
                <div key={verb} className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-primary/10 px-2 py-1 font-mono text-body text-foreground">
                    {cmd}
                  </code>
                  <CopyButton
                    text={cmd}
                    data-testid="copy-cli-cmd"
                    aria-label={`Copy: ${cmd}`}
                  />
                </div>
              )
            })}
          </div>
        </details>
      </section>
    </aside>
    </>
  )
}
