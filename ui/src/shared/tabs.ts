export type Tab = 'board' | 'events'

/** The tab shown on first render. */
export const DEFAULT_TAB: Tab = 'board'

/** Ordered list of tab ids that drives the rendered strip. */
export const TABS: readonly Tab[] = ['board', 'events']

/** Human-readable label shown in the tab strip button. */
export const tabLabel = (tab: Tab): string => {
  switch (tab) {
    case 'board':
      return 'Board'
    case 'events':
      return 'Events'
  }
}
