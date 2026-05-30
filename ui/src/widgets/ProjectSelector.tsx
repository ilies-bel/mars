/**
 * ProjectSelector — lists every registered project in the nav bar with:
 *   - project icon + name (from projectIdentity)
 *   - daemon-health badge: live (green) / degraded (yellow) / down (red)
 *   - a Start button for 'down' projects (the only daemon-spawn trigger)
 *
 * Selecting a project switches the focus and re-scopes all data views to
 * that project. The focused project is highlighted with aria-current="true".
 *
 * Single-project case: renders the same code path with a one-entry list.
 */

import { useState } from 'react'
import { useFocusedProject, useRefreshProjects } from '@/shared/useFocusedProject'
import { projectIdentity } from '@/shared/projectIdentity'
import { startProject } from '@/shared/api'
import type { DaemonHealth } from '@/shared/schemas'

const HEALTH_LABEL: Record<DaemonHealth, string> = {
  live: 'live',
  degraded: 'degraded',
  down: 'down',
}

const healthBadgeClass = (health: DaemonHealth): string => {
  if (health === 'live')
    return 'rounded px-1 font-mono text-[9px] uppercase leading-none bg-green-900/40 text-green-400'
  if (health === 'degraded')
    return 'rounded px-1 font-mono text-[9px] uppercase leading-none bg-yellow-900/40 text-yellow-400'
  return 'rounded px-1 font-mono text-[9px] uppercase leading-none bg-red-900/40 text-red-400'
}

export const ProjectSelector = () => {
  const { projects, focusedProjectId, setFocusedProjectId } = useFocusedProject()
  const refreshProjects = useRefreshProjects()
  const [starting, setStarting] = useState<string | null>(null)

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
      className="flex items-center gap-2"
      data-testid="project-selector"
    >
      {projects.map((p) => {
        const { name, icon } = projectIdentity(p)
        const isFocused = p.projectId === focusedProjectId
        const isStarting = starting === p.projectId
        return (
          <span key={p.projectId} className="flex items-center gap-1">
            <button
              type="button"
              aria-current={isFocused ? 'true' : undefined}
              onClick={() => setFocusedProjectId(p.projectId)}
              data-testid={`project-item-${p.projectId}`}
              className={[
                'flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] transition-colors',
                isFocused
                  ? 'bg-iron/30 text-fg'
                  : 'text-iron hover:text-fg',
              ].join(' ')}
            >
              <span aria-hidden="true">{icon}</span>
              {name}
            </button>
            <span
              className={healthBadgeClass(p.health)}
              data-testid={`health-badge-${p.projectId}`}
            >
              {HEALTH_LABEL[p.health]}
            </span>
            {p.health === 'down' ? (
              <button
                type="button"
                disabled={isStarting}
                onClick={(e) => void handleStart(p.projectId, e)}
                data-testid={`start-btn-${p.projectId}`}
                className="rounded border border-iron/40 px-1.5 py-0.5 font-mono text-[9px] uppercase text-fg hover:bg-iron/20 disabled:opacity-50"
              >
                {isStarting ? '…' : 'Start'}
              </button>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
