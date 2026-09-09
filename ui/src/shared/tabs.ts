export type Tab = 'board' | 'topology' | 'hot-paths'

/**
 * The tab shown on first render.
 *
 * Topology held this slot and had to give it up: it is a node-link diagram,
 * and on a live repo it renders thirteen nodes and ZERO edges above its own
 * footer reading "No dependencies between active arcs." All the machinery of a
 * graph — canvas, zoom controls, minimap — and none of the payoff, while the
 * page's actual headline ("17 Failed") sat at 14px in a corner. A graph with
 * no edges is a scatter of boxes, which is strictly worse than the list Board
 * already draws.
 *
 * Topology stays one click away, and is the right landing view the day arcs
 * routinely depend on each other. It is not that day.
 */
export const DEFAULT_TAB: Tab = 'board'

/** Ordered list of tab ids that drives the rendered strip. The default leads. */
export const TABS: readonly Tab[] = ['board', 'topology', 'hot-paths']

/** Human-readable label shown in the tab strip button. */
export const tabLabel = (tab: Tab): string => {
  switch (tab) {
    case 'board':
      return 'Board'
    case 'topology':
      return 'Topology'
    case 'hot-paths':
      return 'Hot paths'
  }
}
