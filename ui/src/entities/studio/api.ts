/**
 * Studio data access — thin fetchers over the run-timeline and step-prompt
 * endpoints.
 *
 * Studio consumes the SAME per-instance data the task drawer does:
 * `GET /api/runs/:taskId` (proxied to the daemon's `GET /view/runs/:taskId`)
 * is the single source for per-step status, duration, tokens, session ids,
 * failure reasons, and result JSON. No parallel run-detail shape exists —
 * the wire types are the drawer's exported RunTimeline family.
 *
 * The one Studio-specific read is `GET /api/step-prompt` — the composed
 * prompt sent to a step's worker, fetched lazily when a node's Input /
 * Show-trace panel opens (never inlined into timeline lists).
 */

// Studio retains this import surface while sharing the validated, project-aware
// fetchers used by the task drawer and action queue detail.
export { fetchRunTimeline, fetchStepPrompt } from '@/shared/api'
