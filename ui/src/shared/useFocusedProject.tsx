/**
 * Focused-project state: a single source of truth for which project is
 * currently in view. Backed by React Query for the project list (GET
 * /api/projects) and localStorage for persistence across reloads.
 *
 * Rules:
 *   1. On first load, prefer the projectId stored in localStorage if it is
 *      still present in the fetched list.
 *   2. Otherwise default to the first project in the list.
 *   3. Selecting a project persists the choice to localStorage immediately.
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchProjects } from './api'
import type { Project } from './schemas'

const STORAGE_KEY = 'mars:focusedProjectId'

interface FocusedProjectContextValue {
  /** All known projects, or empty while loading. */
  projects: Project[]
  /** The ID of the currently focused project, or null while the list loads. */
  focusedProjectId: string | null
  /** Switch focus to a different project and persist the choice. */
  setFocusedProjectId: (id: string) => void
}

const FocusedProjectContext = createContext<FocusedProjectContextValue>({
  projects: [],
  focusedProjectId: null,
  setFocusedProjectId: () => {},
})

/** Mount this provider inside QueryClientProvider (e.g. in App). */
export const FocusedProjectProvider = ({
  children,
}: {
  children: ReactNode
}) => {
  const query = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    staleTime: 30_000,
  })

  const projects = query.data ?? []

  // Seed from localStorage so the resolved ID is available synchronously on
  // the first render after projects have loaded.
  const [storedId, setStoredId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })

  // The resolved focused ID: prefer the stored ID if it exists in the current
  // list; fall back to the first project; null while loading.
  const focusedProjectId = useMemo<string | null>(() => {
    if (projects.length === 0) return storedId
    if (storedId && projects.some((p) => p.projectId === storedId)) {
      return storedId
    }
    return projects[0]?.projectId ?? null
  }, [projects, storedId])

  const setFocusedProjectId = (id: string): void => {
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      // Ignore storage errors (private-browsing mode, quota exceeded, etc.)
    }
    setStoredId(id)
  }

  return (
    <FocusedProjectContext.Provider
      value={{ projects, focusedProjectId, setFocusedProjectId }}
    >
      {children}
    </FocusedProjectContext.Provider>
  )
}

/** Returns the ID of the focused project, or null while projects are loading. */
export const useFocusedProjectId = (): string | null =>
  useContext(FocusedProjectContext).focusedProjectId

/** Returns the full context value: projects list + focused state + setter. */
export const useFocusedProject = (): FocusedProjectContextValue =>
  useContext(FocusedProjectContext)

/**
 * Invalidate the projects query so the ProjectSelector reflects a daemon
 * health change. Exported for use by ProjectSelector's Start handler.
 */
export const useRefreshProjects = (): (() => Promise<void>) => {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['projects'] })
}
