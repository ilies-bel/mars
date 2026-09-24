# UI topology moves from @antv/g6 to @xyflow/react; supersedes ADR-0043 renderer and ADR-0046

## Status

Accepted (retroactive)

Retroactive record (commit ca92fd041, 2026-07-12). The ui/ topology map dropped @antv/g6 (ADR-0043, ADR-0046) and now renders on @xyflow/react (React Flow) DOM nodes with a deterministic dagre LR layout per connected component, shelf-packed. @antv/g6 is no longer in ui/package.json. This supersedes ADR-0043's renderer choice and ADR-0046's anchored-expand/nudge design, which was built on G6 combos.

Why: G6's force-clustered layout produced a different picture on every mount for the same data; the map needs to be reproducible. Feature parity was kept (arc cards, single-open drill-in, hover lineage trace, search dim, cluster palette, legend, pulse) and MiniMap + Controls were added.

Trade-off: the ~1.38MB canvas/WebGL dependency and its ~11 @antv/* transitive deps are gone, but the viewer still carries a graph library (React Flow) plus dagre, and layout is now our own code (ui/src/widgets/topologyFlowModel.ts). Nodes are DOM, so very large graphs cost more than canvas would.

Later: ADR-0107 changes what the topology view maps (intra-arc lineage), independent of the renderer.

Guardrail decision: no automated ADR-to-manifest dependency drift check. A scan found only two ADRs naming uninstalled packages: 0043/0046 (this drift) and 0047/0056 (@mars/* packages that were planned extractions, superseded by 0056). Frequency is low and legitimate ADRs name planned or removed packages, so a check would need a supersession exemption and would yield noise. Supersession chains plus this record are the control.
