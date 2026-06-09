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
 * ProjectSelectorInner is exported for testing — it is the pure rendering
 * layer; state (open / starting) and effects (outside-click, Escape) live
 * in the wrapping ProjectSelector component.
 */

import { useEffect, useRef, useState } from 'react'
import { useFocusedProject, useRefreshProjects } from '@/shared/useFocusedProject'
import { projectIdentity } from '@/shared/projectIdentity'
import { startProject } from '@/shared/api'
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
  onToggle: () => void
  onSelect: (projectId: string) => void
  onStart: (projectId: string, e: React.MouseEvent) => void
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
  onToggle,
  onSelect,
  onStart,
}: ProjectSelectorInnerProps) => {
  const focusedProject =
    projects.find((p) => p.projectId === focusedProjectId) ?? projects[0]
  const { name: focusedName, icon: focusedIcon } = projectIdentity(focusedProject)

  return (
    <>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="project-selector-trigger"
        className="flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] text-fg transition-colors hover:bg-iron/20"
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
        <span aria-hidden="true" className="ml-1 text-iron">
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Projects"
          data-testid="project-dropdown"
          className="absolute left-0 top-full z-50 mt-1 min-w-[14rem] rounded border border-iron/30 bg-bg shadow-lg"
        >
          {projects.map((p) => {
            const { name, icon } = projectIdentity(p)
            const isFocused = p.projectId === focusedProjectId
            const isStarting = starting === p.projectId
            return (
              <li
                key={p.projectId}
                role="option"
                aria-selected={isFocused}
                aria-current={isFocused ? 'true' : undefined}
                data-testid={`project-item-${p.projectId}`}
                onClick={() => onSelect(p.projectId)}
                className={[
                  'flex cursor-pointer items-center gap-1.5 px-2 py-1.5 font-mono text-[11px] transition-colors',
                  isFocused
                    ? 'bg-iron/30 text-fg'
                    : 'text-iron hover:bg-iron/10 hover:text-fg',
                ].join(' ')}
              >
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
                {p.health === 'down' ? (
                  <button
                    type="button"
                    disabled={isStarting}
                    onClick={(e) => onStart(p.projectId, e)}
                    data-testid={`start-btn-${p.projectId}`}
                    className="ml-auto rounded border border-iron/40 px-1.5 py-0.5 font-mono text-[9px] uppercase text-fg hover:bg-iron/20 disabled:opacity-50"
                  >
                    {isStarting ? '…' : 'Start'}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/**
 * Stateful wrapper — manages open/starting state and attaches outside-click
 * and Escape-key listeners. Renders nothing when no projects are registered.
 */
export const ProjectSelector = () => {
  const { projects, focusedProjectId, setFocusedProjectId } = useFocusedProject()
  const refreshProjects = useRefreshProjects()
  const [starting, setStarting] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

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

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  if (projects.length === 0) return null

  const handleStart = async (
    projectId: string,
    e: React.MouseEvent,
  ): Promise<void> => {
    e.stopPropagation()
    setStarting(projectId)
    try {
      await startProject(projectId)
      await refreshProjects()
    } finally {
      setStarting(null)
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
        onToggle={() => setOpen((o) => !o)}
        onSelect={(id) => {
          setFocusedProjectId(id)
          setOpen(false)
        }}
        onStart={handleStart}
      />
    </div>
  )
}
