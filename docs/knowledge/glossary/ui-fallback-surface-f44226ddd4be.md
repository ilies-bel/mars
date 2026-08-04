# UI fallback surface

A UI region that renders in place of, or alongside, real data when a read fails or returns nothing. A true initial-load failure (no prior data) produces RemoteState kind:'error' and warrants a full-pane FallbackSurface takeover (error copy splits by build mode). A background-refetch failure while prior data is still present produces kind:'stale': the data stays rendered and a thin, non-blocking ReconnectingStrip (ui/src/components/ReconnectingStrip.tsx) appears above it — no pane takeover. A read that returns nothing produces kind:'empty' (empty-state copy, no build-mode split). The RemoteState<T> union lives in ui/src/shared/useRead.ts.

_Avoid_: error panel, error state, fallback UI
