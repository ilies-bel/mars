/**
 * ProjectSelector — a single-trigger dropdown that shows the currently focused
 * project and lets the user switch between all registered projects.
 *
 * Trigger (always visible): focused project icon + name + health badge.
 * Clicking it opens a listbox listing all registered projects. Each row shows:
 *   - project icon + name
 *   - health badge (live / degraded / down)
 *   - Start button for 'down' projects (the only daemon-spawn trigger)
 *
 * Selecting a row calls setFocusedProjectId and closes the dropdown.
 * Escape or an outside click also closes.
 *
 * Keyboard navigation (ARIA listbox pattern):
 *   - ArrowDown / ArrowUp  — move aria-activedescendant across options
 *   - Home / End           — jump to first / last option
 *   - Enter                — select the active option and close
 *   - Escape               — close and return focus to the trigger
 *
 * ProjectSelectorInner is exported for testing — it is the pure rendering
 * layer; state (open / starting / activeIndex) and effects (outside-click,
 * Escape) live in the wrapping ProjectSelector component.
 */

import { useEffect, useRef, useState } from 'react'
import { useFocusedProject, useRefreshProjects } from '@/shared/useFocusedProject'
import { projectIdentity } from '@/shared/projectIdentity'
import { startProject, restartProject } from '@/shared/api'
import type { DaemonHealth, Project } from '@/shared/schemas'

const healthColorClass = (health: DaemonHealth): string => {
  if (health === 'live') return 'text-success'
  if (health === 'degraded') return 'text-warn'
  return 'text-error'
}

// Distinct shape per health state — non-colour cue so health is not hue-only
// for sighted users (WCAG 1.4.1: Use of Colour).
const HEALTH_GLYPH: Record<DaemonHealth, string> = {
  live: '●',
  degraded: '◑',
  down: '○',
}

interface ProjectSelectorInnerProps {
  projects: Project[]
  focusedProjectId: string | null
  open: boolean
  starting: string | null
  /** Which project id is currently being restarted, or null if none. */
  restarting: string | null
  /** Inline error for the last failed Start, or null if none. */
  startError: { projectId: string; message: string } | null
  /** Inline error for the last failed Restart, or null if none. */
  restartError: { projectId: string; message: string } | null
  onToggle: () => void
  onSelect: (projectId: string) => void
  onStart: (projectId: string, e: React.MouseEvent) => void
  onRestart: (projectId: string, e: React.MouseEvent) => void
  /** Index of the keyboard-active option (drives aria-activedescendant). */
  activeIndex?: number | null
  /** Ref forwarded to the trigger button for focus-return on close. */
  triggerRef?: React.Ref<HTMLButtonElement>
  /** Ref forwarded to the listbox ul so the parent can focus it on open. */
  listboxRef?: React.Ref<HTMLUListElement>
  /** Keydown handler attached to the listbox ul. */
  onListboxKeyDown?: (e: React.KeyboardEvent<HTMLUListElement>) => void
}

/**
 * Pure display layer — testable with renderToStaticMarkup.
 * Pass open=false to verify the trigger; open=true to verify the dropdown list.
 */
export const ProjectSelectorInner = ({
  projects,
  focusedProjectId,
  open,
  starting,
  restarting,
  startError,
  restartError,
  onToggle,
  onSelect,
  onStart,
  onRestart,
  activeIndex = null,
  triggerRef,
  listboxRef,
  onListboxKeyDown,
}: ProjectSelectorInnerProps) => {
  const focusedProject =
    projects.find((p) => p.projectId === focusedProjectId) ?? projects[0]
  const { name: focusedName, icon: focusedIcon } = projectIdentity(focusedProject)

  const activatedId =
    activeIndex != null && projects[activeIndex] != null
      ? `ps-opt-${projects[activeIndex].projectId}`
      : undefined

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="project-selector-trigger"
        className="flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-primary/20"
      >
        <span
          role="img"
          aria-label={`${focusedName} — ${focusedProject.health}`}
          title={`${focusedName} — ${focusedProject.health}`}
          className={healthColorClass(focusedProject.health)}
        >
          {HEALTH_GLYPH[focusedProject.health]}
        </span>
        <span aria-hidden="true">{focusedIcon}</span>
        {focusedName}
        <span aria-hidden="true" className="ml-1 text-primary">
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <ul
          ref={listboxRef}
          role="listbox"
          aria-label="Projects"
          tabIndex={0}
          aria-activedescendant={activatedId}
          onKeyDown={onListboxKeyDown}
          data-testid="project-dropdown"
          // max-h-[60vh]: caps at 60% of the viewport so the panel stays inside
          // the window even with 30+ entries; at ~26px/row that shows ~18 rows on
          // an 800px viewport — enough to scan without scrolling, but bounded.
          // overflow-y-auto: scroll internally when the list overflows the cap.
          // overflow-hidden: clips li backgrounds at the ul's rounded corners so
          // the selected row's bg-primary/30 doesn't bleed past the border-radius.
          className="absolute left-0 top-full z-50 mt-1 min-w-[14rem] max-h-[60vh] overflow-y-auto overflow-hidden rounded border border-primary/30 bg-background shadow-lg outline-none"
        >
          {projects.map((p, idx) => {
            const { name, icon } = projectIdentity(p)
            const isFocused = p.projectId === focusedProjectId
            const isActive = activeIndex === idx
            const isStarting = starting === p.projectId
            const isRestarting = restarting === p.projectId
            return (
              <li
                id={`ps-opt-${p.projectId}`}
                key={p.projectId}
                role="option"
                aria-selected={isFocused}
                aria-current={isFocused ? 'true' : undefined}
                data-testid={`project-item-${p.projectId}`}
                onClick={() => onSelect(p.projectId)}
                className={[
                  'flex flex-col cursor-pointer px-2 py-1.5 font-mono text-[11px] transition-colors',
                  isFocused
                    ? 'bg-primary/30 text-foreground'
                    : isActive
                      ? 'bg-primary/10 text-foreground'
                      : 'text-primary hover:bg-primary/10 hover:text-foreground',
                ].join(' ')}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    role="img"
                    aria-label={`${name} — ${p.health}`}
                    title={`${name} — ${p.health}`}
                    className={healthColorClass(p.health)}
                  >
                    {HEALTH_GLYPH[p.health]}
                  </span>
                  <span aria-hidden="true">{icon}</span>
                  {name}
                  {(p.health === 'down' || isFocused) ? (
                    <span className="ml-auto flex items-center gap-1">
                      {p.health === 'down' ? (
                        <button
                          type="button"
                          disabled={isStarting}
                          onClick={(e) => onStart(p.projectId, e)}
                          data-testid={`start-btn-${p.projectId}`}
                          className="rounded border border-primary/40 px-1.5 py-0.5 font-mono text-[9px] uppercase text-foreground hover:bg-primary/20 disabled:opacity-50"
                        >
                          {isStarting ? '…' : 'Start'}
                        </button>
                      ) : null}
                      {isFocused ? (
                        <button
                          type="button"
                          disabled={isRestarting}
                          onClick={(e) => onRestart(p.projectId, e)}
                          data-testid={`restart-btn-${p.projectId}`}
                          className="rounded border border-primary/40 px-1.5 py-0.5 font-mono text-[9px] uppercase text-foreground hover:bg-primary/20 disabled:opacity-50"
                        >
                          {isRestarting ? '…' : 'Restart'}
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                {startError?.projectId === p.projectId && (
                  <p
                    data-testid={`start-error-${p.projectId}`}
                    className="mt-1 font-mono text-[10px] text-error"
                  >
                    {startError.message}
                  </p>
                )}
                {restartError?.projectId === p.projectId && (
                  <p
                    data-testid={`restart-error-${p.projectId}`}
                    className="mt-1 font-mono text-[10px] text-error"
                  >
                    {restartError.message}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/**
 * Stateful wrapper — manages open/starting/activeIndex state and attaches
 * outside-click and Escape-key listeners. Renders nothing when no projects
 * are registered.
 */
export const ProjectSelector = () => {
  const { projects, focusedProjectId, setFocusedProjectId, projectsSettled } = useFocusedProject()
  const refreshProjects = useRefreshProjects()
  const [starting, setStarting] = useState<string | null>(null)
  const [restarting, setRestarting] = useState<string | null>(null)
  const [startError, setStartError] = useState<{ projectId: string; message: string } | null>(null)
  const [restartError, setRestartError] = useState<{ projectId: string; message: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLUListElement>(null)

  // When the dropdown opens, focus the listbox so keyboard events land on it.
  // When it closes, reset the keyboard-active index.
  useEffect(() => {
    if (open) {
      listboxRef.current?.focus()
    } else {
      setActiveIndex(null)
    }
  }, [open])

  // Scroll the keyboard-active option into view whenever activeIndex changes.
  // The listbox uses aria-activedescendant (DOM focus stays on the <ul>), so
  // the browser will NOT auto-scroll — we must do it explicitly. Without this,
  // arrowing past the max-h cap leaves the highlight invisible in the scroll
  // overflow. scrollIntoView({ block: 'nearest' }) moves the minimum amount.
  useEffect(() => {
    if (activeIndex === null || !open) return
    const project = projects[activeIndex]
    if (!project) return
    document.getElementById(`ps-opt-${project.projectId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, projects])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Escape closes and returns focus to the trigger (document-level fallback;
  // also handled inline via onListboxKeyDown for the listbox-focused case).
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  if (projects.length === 0) {
    // While the initial fetch is in flight, hold the trigger's width so nav
    // links don't shift horizontally when projects arrive. w-[140px] matches
    // the resting trigger width (font-mono text-[11px] name + glyphs + px-2).
    // Once settled with no projects, collapse entirely.
    if (!projectsSettled) {
      return <div className="w-[140px] shrink-0" aria-hidden="true" />
    }
    return null
  }

  // Opening sets activeIndex to the currently focused project; closing resets
  // it (handled in the useEffect above).
  const handleToggle = () => {
    if (!open) {
      const idx = projects.findIndex((p) => p.projectId === focusedProjectId)
      setActiveIndex(idx >= 0 ? idx : 0)
    }
    setOpen((o) => !o)
  }

  const handleListboxKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const last = projects.length - 1
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => (i === null ? 0 : Math.min(i + 1, last)))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => (i === null ? last : Math.max(i - 1, 0)))
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        e.preventDefault()
        setActiveIndex(last)
        break
      case 'Enter': {
        e.preventDefault()
        if (activeIndex !== null) {
          setFocusedProjectId(projects[activeIndex].projectId)
          setOpen(false)
          triggerRef.current?.focus()
        }
        break
      }
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        break
    }
  }

  const handleStart = async (
    projectId: string,
    e: React.MouseEvent,
  ): Promise<void> => {
    e.stopPropagation()
    setStarting(projectId)
    setStartError(null)
    try {
      await startProject(projectId)
      await refreshProjects()
    } catch (err) {
      setStartError({
        projectId,
        message: err instanceof Error ? err.message : 'Failed to start',
      })
    } finally {
      setStarting(null)
    }
  }

  const handleRestart = async (
    projectId: string,
    e: React.MouseEvent,
  ): Promise<void> => {
    e.stopPropagation()
    setRestarting(projectId)
    setRestartError(null)
    try {
      await restartProject(projectId)
      await refreshProjects()
    } catch (err) {
      setRestartError({
        projectId,
        message: err instanceof Error ? err.message : 'Failed to restart',
      })
    } finally {
      setRestarting(null)
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      data-testid="project-selector"
    >
      <ProjectSelectorInner
        projects={projects}
        focusedProjectId={focusedProjectId}
        open={open}
        starting={starting}
        restarting={restarting}
        activeIndex={activeIndex}
        triggerRef={triggerRef}
        listboxRef={listboxRef}
        startError={startError}
        restartError={restartError}
        onToggle={handleToggle}
        onSelect={(id) => {
          setFocusedProjectId(id)
          setOpen(false)
        }}
        onStart={handleStart}
        onRestart={handleRestart}
        onListboxKeyDown={handleListboxKeyDown}
      />
    </div>
  )
}
