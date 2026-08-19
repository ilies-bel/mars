/**
 * Is the daemon behind the focused project actually running?
 *
 * Every daemon-backed route (`/api/action-queue`, `/api/progress`, …) answers
 * 503 NO_DAEMON when the daemon is down, but each caller has to notice its own
 * query failed and decide what that means. That is how the Needs-you page came
 * to render "All quiet — nothing running" over a dead daemon: an empty list and
 * a list that could not be loaded are the same value once the error is dropped.
 *
 * `/api/projects` is different. It is served by the mars-ui server's own
 * registry, so it keeps returning 200 while the daemon is down, and each row
 * carries a `health` probed at request time (`ui/server/projectHealth.ts`).
 * That makes it a positive signal rather than an inferred one: we learn the
 * daemon is down from a request that SUCCEEDED, instead of guessing it from
 * requests that failed.
 *
 * Prefer this hook over inspecting individual query errors when the question is
 * "can Mars answer at all" — it stays correct no matter which feed a page reads.
 */

import { useFocusedProject } from '@/shared/useFocusedProject'
import type { DaemonHealth } from '@/shared/schemas'

export interface DaemonHealthState {
  /**
   * The focused project's probed health, or null while the projects list is
   * still loading or when it could not be fetched at all (mars-ui server down).
   * Null means "unknown" and must never be rendered as healthy.
   */
  health: DaemonHealth | null
  /** True only when we positively know the daemon is not running. */
  isDown: boolean
  /**
   * True when the projects list itself could not be loaded — the mars-ui
   * server, not the daemon, is the thing that is unreachable.
   */
  isUiServerUnreachable: boolean
}

export const useDaemonHealth = (): DaemonHealthState => {
  const { projects, focusedProjectId, projectsSettled, projectsError } =
    useFocusedProject()

  if (projectsError !== null) {
    return { health: null, isDown: false, isUiServerUnreachable: true }
  }
  if (!projectsSettled) {
    return { health: null, isDown: false, isUiServerUnreachable: false }
  }

  const focused =
    projects.find((p) => p.projectId === focusedProjectId) ?? projects[0] ?? null

  return {
    health: focused?.health ?? null,
    isDown: focused?.health === 'down',
    isUiServerUnreachable: false,
  }
}
