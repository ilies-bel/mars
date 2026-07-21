# Chat UI Migration — shadcn + AI Elements + AI SDK v7

Branch: `feat/shadcn-ai-elements` · Worktree: `/Users/ib472e5l/project/perso/mars-shadcn-wt`

Status as of final verify. **Nothing committed** — all work is uncommitted in the worktree.

## Verification (final)

- **tsc**: PASS — `npm --prefix ui exec -- tsc -p ui/tsconfig.json --noEmit`, exit 0, zero errors across the whole `ui` src project. (`tsconfig.json` excludes `*.test.*`; tests are gated by vitest.)
- **vitest**: PASS — `npm --prefix ui exec -- vitest run` → **85 files passed, 1489 passed | 3 skipped, 0 failed**.
- No trivial breakages surfaced during final verify; no fix edits were required.

## What landed

### 1. Dependencies (into `ui/package.json`)
`ai@7.0.34`, `@ai-sdk/react@4.0.37`, `streamdown@2.5.0`, `use-stick-to-bottom@1.1.6`,
`lucide-react@1.25.0`, `radix-ui@1.6.4` (unified namespaced package),
`class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.6.0`.
206 packages added, 0 vulnerabilities. `package-lock.json` updated locally (gitignored).

### 2. Theme layer
`ui/src/styles/index.css` — appended the shadcn semantic layer (`:root` + `.dark`
aliases mapped onto existing Mars `--color-*` tokens, plus `@theme inline` bridge),
after the existing `@theme` block. Existing block untouched.

### 3. shadcn + AI Elements components
- `ui/src/lib/utils.ts` — `cn()`.
- `ui/src/components/ui/` — base primitives themed on Mars vars: `button`, `textarea`,
  `collapsible`, `badge`, `tooltip`, `avatar`, `scroll-area`, `select`, `dropdown-menu`.
- `ui/src/components/ai-elements/` — `conversation`, `message`, `response`, `reasoning`,
  `tool`, `prompt-input`, `actions`, `loader`, `image`, `suggestion`.
- `ui/components.json` — shadcn config (for a future `npx shadcn add`).

All 19 component files were hand-authored from the documented AI Elements / shadcn
"new-york" source (the `ai-elements` registry CLI aborted — its registry endpoint
returns "not found"), adapted to the unified `radix-ui` package and Mars vars.

### 4. Custom AI-SDK transport (client-side SSE adapter)
- `ui/src/shared/marsChatTransport.ts` — `createMarsChatTransport({threadId, projectId})`
  implementing the AI SDK v7 `ChatTransport<MarsUIMessage>` interface (`sendMessages`
  + `reconnectToStream`). Maps the daemon's `LiveEvent` SSE union → `UIMessageChunk`
  stream. Exports `MarsUIMessage = UIMessage<MarsMessageMetadata, MarsDataParts>`
  (typed `data-alert` / `data-attachment` / `data-chatError` parts; metadata carries
  daemon usage stats + feedback).
- `ui/src/shared/useMarsChat.ts` — `useMarsChat(...)`, memoises the transport and binds
  `useChat<MarsUIMessage>`.
- `ui/src/shared/chatDeltaBus.ts` — per-thread pub/sub the transport demuxes off, so no
  second `EventSource` is opened; `SseInvalidator` is the single publisher.
- `ui/src/shared/liveEvent.ts` — relocated `LiveEvent` SSE wire union.
- `ui/src/shared/chatMessageMapping.ts` — persisted-history normaliser
  (`chatMessageToUIMessage`, `chatMessagesToUIMessages`, `transcriptSignature`); folds
  `tool_result` into the preceding `tool_use`, maps `result`→metadata usage, and
  `alert`/`attachment`/`error`→typed `data-*` parts. History and live land on the same
  `UIMessage.parts` shape.

### 5. ChatPage rewire
`ui/src/pages/ChatPage.tsx` — message-rendering path fully migrated to AI Elements:
`MessageView` renders each `MarsUIMessage` (text→`Response`/Streamdown,
reasoning→`Reasoning`, `tool-*`→`Tool*`, `data-*`→existing alert/attachment/error cards,
usage→footer). `ChatConversation` owns `useMarsChat`, seeds/reconciles persisted history
via `setMessages` (guarded by `transcriptSignature` + non-streaming status). `Composer`
send/stop routed through `useChat.sendMessage`/`stop` → transport → daemon POST. Removed
the two 2000ms `refetchInterval` polls and the hand-rolled `react-markdown` render.

### 6. Hard cuts (no shim)
- Deleted `ui/src/shared/chatBuffer.ts` and `chatBuffer.test.ts` (the whole live-buffer
  store: `LiveBuffer`/`applyLiveEvent`/`pushLiveEvent`/`useLiveBuffer`/…).
- `SseInvalidator.tsx` repointed from `pushLiveEvent` to `publishChatDelta` (single sink).
- Old ChatPage bubble/segment components removed (`ChatMessageBubble`, `MessageList`,
  `ThinkingBlock`, `ToolActivityGroup`, `groupMessageSegments`, `toolGroupLabel`, …).
- Tests rewritten: `ChatPage.test.tsx`, `ChatPage.composer.test.tsx`; added
  `chatDeltaBus.test.ts`.

## Verified working
- Full `ui` typecheck clean; full vitest suite green (1489 passed).
- Persisted-history rendering, tool-call folding, and the LiveEvent→UIMessageChunk
  mapping are unit-tested (fixture regression preserved end-to-end).
- `Response`(Streamdown) / `Reasoning` / `Tool` render under SSR (`renderToStaticMarkup`).

## Incomplete / behavioral changes (deliberate, NOT bugs to fix here)

1. **Composer/Hero shell not visually reskinned to `PromptInput`.** The bespoke composer
   DOM + logic (attachment chips, mic, voice, drag/paste, slash palette, all `data-testid`s)
   was preserved; only send/stop were rewired through `useChat`. The message-rendering
   path is fully migrated; the composer is functionally migrated but not restyled.
   `prompt-input.tsx` is vendored and available for a follow-up shell swap.

2. **Auto-started (daemon-initiated) alert-origin runs no longer token-stream live.**
   `useChat` only consumes the transport during a user `sendMessage`. A daemon-initiated
   run (alert threads) has no such call, and with the 2000ms poll removed those threads
   now reconcile via the SSE `chat` invalidation → `fetchChatThread` refetch rather than
   incremental streaming. This is a behavioral change from the old global `chatBuffer`
   path. See FOLLOW-UP 1.

3. **`react-markdown` / `remark-gfm` NOT removed** — still consumed by
   `ui/src/widgets/chat/AlertCard.tsx`, so not orphaned. Dependency cleanup is a
   separate step.

## FOLLOW-UPS

1. **Daemon-native AI-SDK data-stream endpoint (highest value).** Replace the
   client-side SSE-adapting transport (`marsChatTransport.ts` + `chatDeltaBus.ts` +
   the `SseInvalidator` demux) with a daemon endpoint that emits the AI SDK v7
   UIMessage data-stream protocol directly, and make `reconnectToStream` resumable
   (it currently returns `null`). This also restores live token streaming for
   daemon-initiated alert-origin runs (see change #2), removing the need for the
   `fetchChatThread` reconcile fallback.

2. **Composer/Hero shell swap to AI Elements `PromptInput`** — port the preserved
   attachment/mic/voice/drag/paste/slash logic onto `PromptInput`'s form + attachment
   context, keeping the `data-testid` contract, then delete the bespoke composer DOM.

3. **Drop `react-markdown` / `remark-gfm`** once `AlertCard.tsx` is migrated to
   `Response`/Streamdown.

4. **Tests still red:** none. Suite is fully green.
