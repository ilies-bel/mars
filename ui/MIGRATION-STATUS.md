# Chat UI Migration — shadcn + AI Elements + AI SDK v7

Branch: `feat/shadcn-ai-elements` · Worktree: `/Users/ib472e5l/project/perso/mars-shadcn-wt`

Status as of **final verify of the three follow-ups**. **Nothing committed** — all
work is uncommitted in the worktree.

## Verification (final)

- **UI tsc**: **PASS** — `npm --prefix ui exec -- tsc -p ui/tsconfig.json --noEmit`,
  exit 0, zero errors. (`tsconfig.json` excludes `*.test.*`; tests are gated by vitest.)
- **Orchestrator tsc**: **PASS** — `npm --prefix orchestrator exec -- tsc -p
  orchestrator/tsconfig.json --noEmit`, exit 0, zero errors.
- **vitest (ui)**: **PASS** — `npm --prefix ui exec -- vitest run` →
  **84 files passed, 1483 passed | 3 skipped, 0 failed** (duration ~4.9s).
- No trivial breakages surfaced during final verify; **no fix edits were required**.

## The three follow-ups — all landed

### FU1 — Daemon-native AI-SDK data-stream endpoint (LANDED)

The `LiveEvent → UIMessageChunk` mapping moved **fully server-side**. The daemon now
emits a mapped, buffered, resumable `UIMessageChunk` stream; the client transport is a
thin pipe; the old client-side `chatDeltaBus` mapping path was hard-cut.

- **Orchestrator (added):** `ui-message-chunks.ts` (hand-rolled `UiMessageChunk` union +
  stateful `ChunkMapper`, verbatim port of the old client `onEvent`; boundary duplication
  is deliberate — no `ai` package in the orchestrator), `chat-stream-hub.ts`
  (`ChatStreamHub`: per-thread run buffer with `(gen, seq)`-tagged chunks, live fan-out,
  snapshot/replay, sealing — the resume primitive). Tests: `ui-message-chunks.test.ts`,
  `chat-stream-hub.test.ts`, `http-ui-stream.test.ts`.
- **Orchestrator (changed):** `chat-runner.ts` (takes optional `ChatStreamHub`;
  `startRun` up-front, `publish` per segment, `finishRun` seals before persistence;
  removed the old `hub.broadcastData('chat', …)` carrier), `http-server.ts` (new route
  `GET /chat/threads/:id/ui-stream`), `server.ts` (one `ChatStreamHub` injected into both
  `ChatRunner` and HTTP deps), `chat-runner.test.ts` (retargeted delta-emission tests to
  the hub).
- **UI (changed):** `marsChatTransport.ts` (rewritten as a thin pipe — `sendMessages`
  POSTs then follows the ui-stream with reconnect; `reconnectToStream` opens it in resume
  mode; client-side `LiveEvent` mapping gone), `api.ts` (`chatUiStreamUrl`),
  `SseInvalidator.tsx` (removed `chat-delta` listener, kept `chat` invalidation ping),
  `ChatPage.tsx` (`resumeStream()` guarded so daemon-initiated alert-origin runs stream
  live; `fetchChatThread` reconcile remains as fallback), `server/index.ts` (streaming SSE
  proxy `GET /api/chat/thread/:id/ui-stream`), `server/chatBridge.ts` (`chat` channel now
  pure invalidation ping).
- **UI (deleted, hard cut):** `chatDeltaBus.ts`, `chatDeltaBus.test.ts`, `liveEvent.ts`
  — no remaining importers.

**Wire contract:** `GET /chat/threads/:id/ui-stream?mode=send|resume&lastEventId=<gen>.<seq>`
→ `text/event-stream`; a `protocol {"v":1}` frame, then one AI-SDK `UIMessageChunk` per
`id: <gen>.<seq>` frame, `: ping` heartbeat every 30s. `mode=send` always streams the
current/next run (buffer replay covers a run that finished before connect); `mode=resume`
streams only when a run is active, else `204` (also `204` when no hub is configured).

### FU2 — Composer / Hero reskin to AI Elements PromptInput (LANDED)

Both composers in `ChatPage.tsx` reskinned to the AI Elements PromptInput visual family,
themed via Mars-mapped shadcn semantic tokens. **No behavior/state/handler logic changed**
— only the JSX shell and class tokens.

- **Composer:** hand-rolled `flex items-end` row → PromptInput card shell
  (`divide-y … rounded-xl border bg-background shadow-sm`) holding `PromptInputTextarea`
  + `PromptInputToolbar` (left `PromptInputTools`: attach + mic; right
  `PromptInputSubmit`/`PromptInputButton`: send/stop). Attachment chips restyled to match
  `PromptInputAttachment`; emoji glyphs → lucide icons.
- **HeroComposer:** absolute-positioned textarea+button → same PromptInput card
  (`rounded-2xl`).
- **Deliberate deviation (noted):** the `<PromptInput>` **form wrapper itself was NOT
  used** — it renders its own hidden `<input type="file">` and manages attachments through
  an internal `FileUIPart` context that drops the underlying `File`, which would break
  Mars's real upload path (`uploadAttachment` needs the `File`) and hijack the composer
  test's `input[type="file"]` selector. Instead PromptInput's exact classNames were applied
  to a plain container and the presentational subcomponents composed on top; Mars keeps
  ownership of attachment state, upload, send, mic, and slash-palette.
  `PromptInputSubmit`'s hardcoded `type="submit"` is overridden to `type="button"`.
- All `data-testid`s (`composer`, `attach-btn`, `mic-btn`, `send-btn`, `stop-btn`,
  `attachment-chips`, `attachment-chip`, `remove-attachment`, `composer-send-error`,
  `hero-composer`, `hero-send`) and aria-labels preserved. Only `ChatPage.tsx` touched.

### FU3 — Drop react-markdown / remark-gfm (LANDED)

`AlertCard.tsx` migrated off `react-markdown` + `remark-gfm` to
`import { Response } from '@/components/ai-elements/response'` — the changelog renderer is
now `<Response>{detail.changelog}</Response>` (Streamdown has GFM built in). Wrapping
`chat-markdown prose` `<dd>` and all surrounding structure/aria untouched.
`react-markdown` and `remark-gfm` entries removed from `ui/package.json` (lockfile /
`node_modules` left untouched). **Zero remaining consumers:**
`grep -rn "react-markdown\|remark-gfm" ui/src` returns no matches. AlertCard's 40 tests
pass.

## Behavioral changes to be aware of

- **Live streaming for daemon-initiated alert-origin runs is RESTORED** (was the main
  regression from the initial migration). It now streams incrementally via the daemon
  ui-stream + `resumeStream()`, instead of only reconciling via `fetchChatThread` refetch.
  The refetch reconcile remains as a fallback.
- **Streaming is now resumable** — `reconnectToStream` opens the ui-stream in resume mode
  with a `(gen, seq)` cursor and replays buffered chunks newer than the cursor before
  following live (previously returned `null`).

## Remaining follow-ups

- **None blocking.** All three planned follow-ups landed; suite is fully green; both
  typechecks clean.
- **Live E2E not exercised (verification caveat):** this environment has no running
  daemon/UI/browser, so FU1's three-hop stream (browser → UI server → daemon) was verified
  only via tsc + unit/integration tests (mapper, hub, the real HTTP route via
  `startHttpServer`, transport consumers, SSE proxy) — not a live browser session.
- **Lockfile / node_modules cleanup:** `react-markdown` / `remark-gfm` were removed from
  `package.json` but `package-lock.json` and `node_modules` were intentionally left
  untouched; a `npm install` to prune them is a mechanical follow-up.
- **Nothing committed** — all work remains uncommitted in the worktree.
