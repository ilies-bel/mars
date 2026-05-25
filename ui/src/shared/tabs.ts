export type Tab = 'board' | 'topology' | 'events'

/** The tab shown on first render — the DAG (topology) view is the default. */
export const DEFAULT_TAB: Tab = 'topology'

/** Ordered list of tab ids that drives the rendered strip. */
export const TABS: readonly Tab[] = ['topology', 'board', 'events']

/** Human-readable label shown in the tab strip button. */
export const tabLabel = (tab: Tab): string => {
  switch (tab) {
    case 'board':
      return 'Board'
    case 'topology':
      return 'Topology'
    case 'events':
      return 'Events'
  }
}
