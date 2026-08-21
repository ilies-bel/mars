/**
 * Agent-vocabulary re-exports — the non-`Executor`-contract half of
 * `core/lib/git/claude.ts` that callers outside this port still need.
 *
 * None of these describe "run one agent invocation and report its transcript"
 * (that is `Executor.run`, resolved via `./registry.ts`); they are the shared
 * plumbing every provider adapter builds a run out of, plus two process-level
 * utilities the daemon and the merge path need:
 *
 *   - `runSubprocessStreaming` — the line-streaming subprocess primitive the
 *     codex and gemini headless adapters spawn their own CLI with.
 *   - `buildWorkerEnv` — the sanitized worker environment (PATH repair,
 *     agent-var stripping, `MARS_MCP_TASK_ID` stamping) shared by every
 *     provider spawn, headless or pty.
 *   - `claudeStreamArgs` — the `claude -p` argv builder, used by the
 *     vcs-supervisor invocation in `core/lib/git/merge.ts`.
 *   - `emptyPromptResult` / `isBlankPrompt` — the blank-prompt guard every
 *     headless adapter applies before spawning (see the `empty-prompt` error
 *     class in `core/lib/failure-signature.ts`).
 *   - `extractSessionIdFromConversation` — reads the session id back out of a
 *     transcript, for adapters and callers whose provider does not report one
 *     on the result.
 *   - `toClaudeSessionId` — normalises a Mars task/session id into the UUID
 *     shape the CLI's `--session-id` flag accepts.
 *   - `AGENT_TO_USER_DENIED_TOOLS` — the permanently-banned agent-to-user
 *     tools, unioned into every run's denials at the wrapper layer.
 *   - `resolveClaudeBin` — locates the `claude` binary (PATH, then the POSIX
 *     fallback dirs), for callers that spawn the CLI themselves rather than
 *     through `Executor.run` — today the vcs-supervisor invocation in
 *     `core/lib/git/merge.ts`.
 *   - `killAllChildren` — SIGKILLs every live agent child, used by the
 *     daemon's `kill` RPC handler.
 *
 * Re-exported here, rather than left as direct `core/lib/git/claude` imports,
 * so the `executor-port-only` arch-guard rule holds: every outside caller
 * reaches `claude.ts` through this port directory, never around it
 * (ADR-0097). See `./types.ts` for the type-level counterpart of this
 * re-export, and `./registry.ts` for the `run()` contract itself.
 */
export {
  AGENT_TO_USER_DENIED_TOOLS,
  buildWorkerEnv,
  claudeStreamArgs,
  emptyPromptResult,
  extractSessionIdFromConversation,
  isBlankPrompt,
  killAllChildren,
  resolveClaudeBin,
  runSubprocessStreaming,
  toClaudeSessionId,
} from '../../lib/git/claude'
