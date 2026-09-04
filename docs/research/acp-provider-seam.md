# ACP (Agent Client Protocol) as a Mars Provider Seam — Research Findings

**Date:** 2026-09-04  
**Task:** mars-55233d90  
**Status:** READ-ONLY investigation — no orchestrator code changed

---

## Executive Summary

**Verdict: DEFER**

ACP's mid-turn `session/request_permission` round-trip does NOT fatally violate the serializable `HeadlessRunOpts` contract — the adapter can auto-respond based on `permissionMode` without needing a callback in that type. The seam survives. However, two conditions must hold before the work is worth starting:

1. ACP must have stabilized beyond "experimental" on at least Claude Code and Gemini CLI (both currently carry `--experimental-acp` flags).
2. `bypassPermissions` / `acceptEdits` mode must be verified to suppress **all** `session/request_permission` calls for each target agent when running headless — stub-only tests cannot confirm this.

Until both conditions hold, the implementation complexity (bidirectional JSON-RPC subprocess driver, per-agent compatibility testing) exceeds the confidence level in the protocol's stability. The payoff is real — one generic adapter for 40+ agents — but not yet de-risked enough to build against.

---

## 1. Protocol Fit: What ACP Actually Specifies

ACP is a **JSON-RPC 2.0** protocol transported over **stdin/stdout** (newline-delimited JSON). The editor/host spawns the agent CLI as a subprocess and exchanges messages bidirectionally on that pipe. The protocol has two stable versions (v1, v2).

### Lifecycle sequence

```
Client → Agent:  initialize          (capability negotiation)
Agent → Client:  initialize response (agent capabilities, auth methods)
Client → Agent:  authenticate        (if required)
Client → Agent:  session/new         (cwd, MCP servers, permission mode)
Agent → Client:  NewResponse         (sessionId)
Client → Agent:  session/prompt      (sessionId, content blocks)  ← LONG-RUNNING JSON-RPC call
  [during prompt processing:]
  Agent → Client: session/update     (notifications — streaming chunks, tool status)
  Agent → Client: session/request_permission  ← agent calls INTO client; blocks waiting for response
  Client → Agent: RequestPermissionResponse   (outcome: selected | cancelled)
  Agent → Client: session/update     ...
Agent → Client:  PromptResponse      (stopReason: end_turn | max_tokens | max_turn_requests | refusal | cancelled)
Client → Agent:  session/close       (optional cleanup)
```

### Key observations

- **Agent methods** (client calls into agent): `initialize`, `authenticate`, `session/new`, `session/load`, `session/resume`, `session/prompt`, `session/cancel`, `session/close`, `session/list`, `session/delete`, `session/set_mode`, `session/set_config_option`.
- **Client methods** (agent calls into client): `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`, `session/request_permission`, `session/update`, `elicitation/create`.
- `session/prompt` is a single long-running JSON-RPC request that completes only when the agent finishes the turn.
- `session/update` notifications are one-way (agent → client, no response required).
- `session/request_permission` is a genuine **request** from the agent to the client, with a required synchronous `RequestPermissionResponse` before the agent continues.

### Permission request shape

```jsonc
// Agent → Client
{
  "jsonrpc": "2.0",
  "method": "session/request_permission",
  "id": 4,
  "params": {
    "sessionId": "sess_abc",
    "toolCall": { /* ToolCallUpdate */ },
    "options": [ { "id": "allow_once", "title": "Allow once" }, { "id": "allow_always", "title": "Always allow" } ]
  }
}

// Client → Agent (required before agent continues)
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": { "outcome": { "selected": "allow_once" } }
}
// OR on session/cancel:
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": { "outcome": "cancelled" }
}
```

---

## 2. Contract Fit — The Decisive Question

### What `HeadlessRunOpts` has and what ACP needs

`HeadlessRunOpts` (`provider-types.ts:67`) is the serializable request type. Its doc comment says: "every field here is plain data (strings, numbers, booleans, readonly arrays/records) with no function values and no AbortSignal." The three non-serializable extras — event callback, abort signal, PID callback — live separately on `HeadlessRunContext`.

**The ACP turn model maps cleanly onto `HeadlessAdapter.run(prompt, opts, ctx)`:**

| Mars concept | ACP equivalent |
|---|---|
| `run(prompt, opts, ctx)` call | initialize → session/new → session/prompt sequence |
| `ctx.onEvent(AgentEvent)` | each `session/update` notification parsed into AgentEvent |
| `ctx.externalAbort` | sends `session/cancel` notification |
| `ctx.onPid` | invoked after subprocess spawn, unchanged |
| `opts.permissionMode` | passed at `session/new` or `session/set_config_option` |
| `opts.cwd` | passed at `session/new` |
| `opts.model` | passed at initialize / session/new config |
| `opts.disallowedTools` | no ACP equivalent — see below |
| `RunAgentResult.conversation` | accumulated events from all `session/update` notifications |
| `RunAgentResult.sessionId` | ACP's `sessionId` from `session/new` response |

**Fields with NO ACP equivalent:**

- `opts.disallowedTools` — ACP has no per-tool deny mechanism; per-tool blocking must be configured inside the agent (e.g., `--allowedTools` for Claude Code) before or instead of an ACP session. The adapter would need to translate these to agent-specific pre-launch flags, or they would be silently ignored.
- `opts.bare` — Claude Code–specific; no ACP concept.
- `opts.agent` — Claude Code sub-agent selection; no ACP concept.
- `opts.forceSandbox` — macOS sandbox mode; no ACP concept. ACP agents run in whatever sandbox the host configures.
- `opts.maxContextTokens` — no standard ACP field for context-window ceiling; might be expressible via `session/set_config_option` for Claude Code ACP but not generically.

**ACP concepts Mars has nowhere to put:**

- `fs/read_text_file`, `fs/write_text_file` — ACP agents can delegate file I/O to the client. Claude Code in ACP mode uses its OWN built-in tools (Read, Edit, Bash) and does NOT call these; they are relevant only for ACP-native agents that have no built-in tool set.
- `terminal/create`, `terminal/wait_for_exit`, etc. — same as above. ACP-native agents delegate shell execution to the client. Claude Code doesn't.
- `elicitation/create` — structured form requests (UI interaction); no headless equivalent and cannot map to any Mars field.

The `elicitation/create` method is the one truly unroutable call. A headless adapter receiving it has no user to show a form to. The correct response is to reject it; that would abort the agent's current action but not kill the session.

### The mid-turn permission round-trip: the deciding issue

The concern: `session/request_permission` is a JSON-RPC call from the agent TO the adapter that blocks until the adapter responds. If the adapter needs a callback in `HeadlessRunContext` to handle it, that callback is a function — not Port-legal in `HeadlessRunOpts`.

**Conclusion: no callback required, and here's why.**

The adapter auto-responds based on `opts.permissionMode`, which is already a plain string in `HeadlessRunOpts`. The logic is:

```
permissionMode == 'bypassPermissions'  → respond { outcome: { selected: 'allow_always' } } for all requests
permissionMode == 'acceptEdits'        → respond allow for write/edit tool calls, reject others
permissionMode == 'dontAsk'            → respond { outcome: 'cancelled' } for all requests (the dontAsk contract)
permissionMode == 'default'/'plan'     → respond { outcome: 'cancelled' } — no user present headless
```

No new function is needed in `HeadlessRunContext`. The adapter maps the existing `opts.permissionMode` value (a `string`) to a policy and applies it when `session/request_permission` arrives. `HeadlessRunOpts` stays fully serializable.

**The practical path:** Launch the agent with `bypassPermissions` mode configured at session start. For Claude Code under ACP, this suppresses `session/request_permission` entirely — the agent auto-approves its own tool calls without checking with the client. The bidirectional round-trip never fires. This is the same guarantees Mars already has from `--dangerously-skip-permissions` on the Claude adapter.

**The caveat:** Whether `bypassPermissions` at `session/new` actually suppresses all `session/request_permission` calls for every target agent is UNVERIFIED. Claude Code's ACP adapter (github.com/Xuanwo/acp-claude-code, the Zed-maintained bridge) does enumerate `bypassPermissions` as a mode. Whether it's wired correctly under the agent's headless path requires testing against the real binary — stub-only tests will pass regardless.

---

## 3. Port Legality

`HeadlessRunOpts` survives ACP unchanged — no field needs to become a function. The adapter's internal implementation IS more complex:

**What's different from current adapters (codex, gemini):**

1. **Bidirectional subprocess channel.** Current adapters write the prompt as a CLI argument and read only stdout. The ACP adapter must ALSO write JSON-RPC messages to stdin after the process starts: the initialize handshake, session/new, session/prompt, and responses to permission/fs/terminal requests. This requires a subprocess driver that holds a writable handle to stdin — `runSubprocessStreaming` as used by the codex adapter doesn't do this and would need a new sibling function.

2. **JSON-RPC message router.** The adapter must parse incoming messages and classify them as: notifications (session/update → call ctx.onEvent), requests (session/request_permission → auto-respond), or the final session/prompt response (→ return RunAgentResult). This is a non-trivial event loop but a self-contained implementation detail; it doesn't leak into the contract.

3. **`readOutput(stdout: string): AgentEvent[]`.** This method is for after-the-fact parsing of a completed stdout. For ACP, stdout is a stream of JSON-RPC envelopes (both notifications and responses). A valid `readOutput` implementation would parse these back into AgentEvents, skipping non-event envelopes. It's compatible in type but needs ACP-aware parsing rather than the Claude NDJSON parser.

**Port legality verdict: preserved.** The `HeadlessRunOpts`/`HeadlessRunContext` split is respected. The implementation burden is internal to the adapter file.

---

## 4. Autonomy Fit

Mars runs headless with no human present. ACP was designed for interactive editor use. The mapping:

| ACP concept | Mars headless answer |
|---|---|
| `session/request_permission` round-trip | Auto-respond from `opts.permissionMode` (no human, no callback) |
| `elicitation/create` (form request) | Return error/cancel — no user to show a form to |
| `bypassPermissions` session mode | Mapped from existing `AgentPermissionMode.bypassPermissions` |
| `acceptEdits` session mode | Mapped from existing `AgentPermissionMode.acceptEdits` |
| `session/cancel` | Send on `ctx.externalAbort` signal |
| `dontAsk` | Cancel all permission requests, consistent with dontAsk semantics |

`AgentPermissionMode` in `git/claude.ts:257` already enumerates `'bypassPermissions'`, `'acceptEdits'`, `'dontAsk'`, `'auto'`, `'default'`, `'plan'`. The ACP session config accepts these same names (Claude Code's ACP bridge documents them explicitly). The mapping is direct, not a translation problem.

`auto` mode (background safety checks, research preview) has no ACP equivalent today. The adapter would need to degrade it to `acceptEdits` or `bypassPermissions`.

---

## 5. Payoff: Which Agents Ship ACP Today

From the official ACP agent registry and OpenClaw harness documentation (as of September 2026):

| Agent | Binary / Entry | ACP flag | Stability |
|---|---|---|---|
| Claude Code | `claude` | `--experimental-acp` | **Experimental** — Anthropic ships this under the `experimental` label |
| Gemini CLI | `gemini` | `--experimental-acp` | **Experimental** — Google ships this under the `experimental` label |
| GitHub Copilot CLI | `gh copilot` (or `copilot`) | `--acp` | **Public Preview** |
| Kiro | `kiro` | `--acp` (or subcommand) | Stable per Kiro docs |
| Cursor | `cursor-agent acp` | subcommand | Stable per Cursor docs |
| OpenCode | `opencode` | native ACP | Stable |
| Qwen Code | `qwen` / `qoder` | `--acp` | Provider-dependent |
| Kimi | `kimi` | `--acp` / `acp` subcommand | Requires `model_arg_first=true` (model flag precedes ACP subcommand) |

The registry lists 40+ agents. The Vicoa prior art (github.com/vicoa-ai/vicoa, AGPLv3, design reference only) drives five of these from a single ~380-line generic ACP module. Their `model_arg_first` flag handles the Kimi/Gemini argument ordering difference.

**Shipped-and-stable distinction:** Kiro, Cursor, and Copilot ship ACP under non-experimental labels. Claude Code and Gemini carry the `--experimental-acp` flag, which per standard semantic-versioning norms signals no stability guarantee. Adding Mars support while these flags are experimental means each agent release could break the adapter silently.

---

## 6. Verdict: DEFER

### What would have to be true first

1. **ACP flag stability on priority agents.** `claude --experimental-acp` must graduate to a stable flag (or a non-experimental ACP-mode CLI surface). Gemini CLI's `--experimental-acp` has the same requirement. Until then, each agent release is a potential silent break. Kiro and Copilot are already stable; building ACP support against those two alone is lower-risk but lower-payoff given Mars's current codex-as-default configuration.

2. **Verified bypassPermissions in ACP mode.** A test against the real `claude` binary (ACP mode, `bypassPermissions`) must confirm zero `session/request_permission` calls during a typical coder run. The correctness argument above holds analytically — the adapter CAN auto-respond without a callback — but the CLAIM that `bypassPermissions` suppresses the round-trip entirely must be validated against a real binary. A stub-only test cannot catch a bug in the agent's ACP implementation that emits permission requests anyway.

3. **Bidirectional subprocess driver.** `runSubprocessStreaming` needs a sibling that holds a writable stdin handle and supports interleaved reads and writes. This is a new infrastructure piece in `core/ports/executor/` with its own tests.

### What the adapter would look like (if the above conditions held)

**Files that change:**
- New: `orchestrator/src/core/workers/providers/acp-headless.ts` — the generic adapter
- New: `orchestrator/src/core/ports/executor/executor-helpers-acp.ts` (or extend existing) — bidirectional subprocess driver
- Extend: `orchestrator/src/core/workers/provider-registry.ts` — one row per target agent
- No change to: `provider-types.ts`, `HeadlessRunOpts`, `HeadlessRunContext`, `HeadlessAdapter`

**Declarative row shape** (analogous to Vicoa's catalog table):
```typescript
interface AcpProviderSpec {
  name: ProviderName        // 'claude-acp', 'gemini-acp', etc.
  binaries: string[]        // PATH candidates, first match wins
  acpArgs: string[]         // args to enter ACP mode e.g. ['--experimental-acp']
  modelArg?: string         // flag that sets model, e.g. '--model'
  modelArgFirst?: boolean   // true for Kimi: model flag must precede acp args
  initializeTimeoutMs?: number
  installHint?: string
}
```

**`acp-headless.ts` sketch (~350 lines):**
```typescript
// Single shared implementation; per-agent differences live in the spec table.
export function makeAcpHeadless(spec: AcpProviderSpec): HeadlessAdapter {
  return {
    capabilities: { usageSemantics: 'none', quotaRejected: false, sessionId: true },
    readOutput: parseAcpOutput,  // parse ACP JSONL into AgentEvents
    run: async (prompt, opts, ctx) => {
      const argv = buildAcpArgv(spec, opts)
      // spawn with stdin writable
      const proc = spawnBidirectional(providerBinPath(spec.binaries), argv, opts.cwd, ctx?.onPid)
      // JSON-RPC message loop
      const session = await handshake(proc, spec, opts)  // initialize + session/new
      await sendPrompt(proc, session.sessionId, prompt)    // session/prompt
      // route incoming messages until session/prompt response arrives
      const result = await driveSession(proc, session, opts, ctx)
      return result
    },
  }
}

// driveSession handles:
//   session/update       → parse → ctx.onEvent(event)
//   session/request_permission → autoRespond(opts.permissionMode)
//   elicitation/create   → respond with error/cancel
//   fs/*, terminal/*     → respond with "not supported in headless mode" error
//   PromptResponse       → assemble RunAgentResult and return
```

**Estimated work:** 3–5 days for a single-agent prototype (Claude Code ACP), plus 1–2 days per additional agent for compatibility testing. The bidirectional subprocess driver is the bulk of the new code.

---

## 7. Proposed ADR Draft (for operator review)

The operator should decide whether to file this as an ADR. Draft text:

> **ADR-XXXX: ACP provider seam — DEFER pending protocol stability**
>
> **Context:** Mars currently has three bespoke provider adapters (claude, codex, gemini). ACP would replace N adapters with one generic one plus a declarative table row per agent.
>
> **Decision:** Do not implement the ACP adapter until `--experimental-acp` graduates to a stable interface on Claude Code and Gemini CLI, AND until bypassPermissions mode is confirmed to suppress all session/request_permission round-trips against a real binary.
>
> **Rationale:** The `HeadlessRunOpts` serializable contract is preserved — ACP's mid-turn permission round-trips are handleable without a callback, by mapping `opts.permissionMode` to a static auto-approve policy inside the adapter. The blocker is protocol instability, not a contract mismatch.
>
> **Consequences:** Revisit when experimental flags graduate. The adapter shape is documented in `docs/research/acp-provider-seam.md` for continuity.

---

## References

- ACP homepage and agent registry: https://agentclientprotocol.com/get-started/agents
- ACP schema: https://agentclientprotocol.com/protocol/schema
- Claude Code ACP bridge (Xuanwo): https://github.com/Xuanwo/acp-claude-code
- Claude Code ACP bridge (Zed): https://github.com/zed-industries/claude-code-acp (DeepWiki: https://deepwiki.com/zed-industries/claude-code-acp/7.1-agent-client-protocol-(acp))
- acpx headless CLI: https://github.com/openclaw/acpx
- OpenClaw ACP agents catalog: https://docs.openclaw.ai/tools/acp-agents
- Copilot CLI session/request_permission issue: https://github.com/github/copilot-cli/issues/845
- ACPex Elixir client overview: https://acpex.hexdocs.pm/protocol_overview.html
- ACP community overview: https://agentic-ai.readthedocs.io/en/latest/Standards/agent-client-protocol/
- Kiro ACP docs: https://kiro.dev/docs/cli/acp/
- Cursor ACP docs: https://cursor.com/docs/cli/acp
- ACP ecosystem article: https://www.danilchenko.dev/posts/agent-client-protocol/
- Zed ACP overview: https://zed.dev/acp
