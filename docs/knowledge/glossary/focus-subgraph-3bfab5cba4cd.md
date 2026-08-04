# Focus subgraph

The slice of the Graph view's blocker DAG anchored at a hovered or selected node: its full upstream blocker chain to the roots, its full downstream dependents to the deepest still-pending leaf (all paths through diamonds, following blocker edges across Proposal-cluster boundaries), and the originating Proposal attached as a fixed provenance hop; anchoring on a Proposal instead yields the whole forest that Proposal sliced.

_Avoid_: focus query, focus mode, chain
