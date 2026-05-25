// Placeholder body for the Topology tab on the Progress page.
//
// This is the slice-2 tracer-bullet shell — later slices in the same PRD
// thicken this into a real DAG rendering of blocker edges. For now the
// component only proves that the Progress page can swap its body when the
// operator clicks the Topology tab.
export const TopologyView = () => (
  <main
    data-testid="topology-view"
    className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-bg p-4 font-mono text-[12px] text-iron"
  >
    Topology view — DAG rendering arrives in a later slice.
  </main>
)
