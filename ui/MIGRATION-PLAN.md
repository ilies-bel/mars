# Mars Chat UI → Vercel AI SDK + shadcn AI Elements — Implementation Plan

Single ordered plan synthesised from the four investigation briefs. Worktree
root: `/Users/ib472e5l/project/perso/mars-shadcn-wt` (branch
`feat/shadcn-ai-elements`). All paths below are relative to that root unless
absolute. This is a **hard cut**: by the end, the `chatBuffer.ts` live-buffer
path is deleted, not duplicated.

## Fixed decisions (do not relitigate)

- `useChat` (`@ai-sdk/react`) drives chat, UIMessage/parts model, rendered by
  vendored shadcn AI Elements.
- Daemon streaming protocol is **unchanged**. A custom client-side
  `MarsChatTransport` translates the existing `chat-delta` SSE `LiveEvent`
  stream into a `UIMessageChunk` stream. A daemon-native AI-SDK endpoint is a
  follow-up, out of scope.
- Mars visual identity kept: shadcn semantic CSS vars alias **onto** the
  existing `@theme` tokens in `ui/src/styles/index.css`. Structural swap, not a
  reskin.
- No compat shims. Old `chatBuffer` path removed at cut.

## Grounding facts confirmed in this worktree

- `@/*` → `src/*` alias **already exists** in both `ui/tsconfig.json`
  (`baseUrl:"."`, `paths`) and `ui/vite.config.ts` (`resolve.alias`). **No
  alias work is required** (Brief D assumed it was missing — it is not).
  `@types/node@^25` is already a devDep; the `fileURLToPath` form is already
  used in `vite.config.ts`.
- `ui/src/lib/` does **not** exist yet — must be created for `cn()`.
- Present deps to be removed at cut: `react-markdown`, `remark-gfm`.
- Missing deps (all of §1): `ai`, `@ai-sdk/react`, `streamdown`,
  `use-stick-to-bottom`, `lucide-react`, `radix-ui`, `class-variance-authority`,
  `clsx`, `tailwind-merge`.
- `ui/src/shared/SseInvalidator.tsx` lines 88–100: the single `chat-delta`
  listener that calls `pushLiveEvent(threadId, event)` — the repoint site.
- Chat test files: `pages/ChatPage.test.tsx`, `pages/ChatPageResolved.test.tsx`,
  `pages/ChatHero.test.tsx`, `pages/ChatThreadDelete.test.tsx`,
  `pages/ChatPage.composer.test.tsx`, `pages/ChatPageSidebarMerge.test.tsx`,
  `shared/SseInvalidator.test.tsx`, `shared/chatBuffer.test.ts`, plus
  `widgets/chat/*` (AlertCard, QueueThreadDetail, QueueThreadRow, queueThreads).

---

## 1. Dependencies

Runtime + build deps to add to `ui` (versions verified in Brief D as
current-latest 2026-07; loosen `^` as desired):

```bash
npm --prefix ui install \
  ai@^7.0.34 \
  @ai-sdk/react@^4.0.37 \
  streamdown@^2.5.0 \
  use-stick-to-bottom@^1.1.6 \
  lucide-react@^1.25.0 \
  radix-ui@^1.6.4 \
  class-variance-authority@^0.7.1 \
  clsx@^2.1.1 \
  tailwind-merge@^3.6.0
```

Notes:
- `@types/node` already present — **do not** re-add.
- `@ai-sdk/provider-utils`, `@ai-sdk/provider`, `nanoid` come transitively —
  do not add explicitly.
- Use the modern unified `radix-ui` package (AI Elements import
  `import { Collapsible, Select, ... } from "radix-ui"`), not per-primitive
  `@radix-ui/react-*`.

**Removed at cut (Step 8):** `react-markdown`, `remark-gfm` — once `Response`
(Streamdown) is the only markdown renderer and no other consumer remains
(grep first).

---

## 2. Theming layer + `cn()` util + alias

### 2a. CSS — append to `ui/src/styles/index.css` **after** the existing
`@theme { … }` block (after line 98). Do **not** edit the existing block; this
only *adds* an alias layer pointing back at the Mars tokens (single source of
truth stays the Mars `--color-*` tokens).

```css
/* ── shadcn semantic layer — aliases onto Mars @theme tokens ── */
:root {
  --background: var(--color-bg);             /* #F5EDE4 */
  --foreground: var(--color-fg);             /* #1A0F0A */
  --card: var(--color-surface);              /* #FFFFFF */
  --card-foreground: var(--color-fg);
  --popover: var(--color-surface);
  --popover-foreground: var(--color-fg);
  --primary: var(--color-iron);              /* #9C2E35 — chat de-facto primary */
  --primary-foreground: #FFFFFF;
  --secondary: var(--color-panel);           /* #FBF7F2 */
  --secondary-foreground: var(--color-fg);
  --muted: var(--color-bg);                  /* #F5EDE4 — bg, NOT Mars text-muted */
  --muted-foreground: var(--color-muted);    /* #705F50 — Mars's old text-muted value */
  --accent: var(--color-border);             /* #E5D9CB — neutral hover bg */
  --accent-foreground: var(--color-fg);
  --destructive: var(--color-error);         /* #B91C1C */
  --destructive-foreground: #FFFFFF;
  --border: var(--color-border);             /* #E5D9CB */
  --input: var(--color-border);
  --ring: var(--color-flame);                /* #9A4F00 — matches :focus-visible */
  --radius: 0.5rem;                          /* rounded-lg */
}

.dark {
  --background: var(--color-surface-dark);   /* #251812 */
  --foreground: var(--color-fg-dark);        /* #F5EDE4 */
  --card: #2E1E15;                           /* elevated (no Mars dark-card token) */
  --card-foreground: var(--color-fg-dark);
  --popover: #2E1E15;
  --popover-foreground: var(--color-fg-dark);
  --primary: var(--color-iron);
  --primary-foreground: var(--color-fg-dark);
  --secondary: var(--color-border-dark);     /* #3A2820 */
  --secondary-foreground: var(--color-fg-dark);
  --muted: var(--color-border-dark);
  --muted-foreground: var(--color-muted-dark);/* #A89684 */
  --accent: var(--color-border-dark);
  --accent-foreground: var(--color-fg-dark);
  --destructive: #DC2626;
  --destructive-foreground: var(--color-fg-dark);
  --border: var(--color-border-dark);
  --input: var(--color-border-dark);
  --ring: var(--color-amber);                /* #E8A33D — matches .dag-canvas ring */
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-xl: calc(var(--radius) + 4px);
}
```

- `@theme inline` (not plain `@theme`) is **mandatory** so `.dark` overrides
  propagate to generated utilities.
- Do **not** convert to HSL/oklch — Mars values are hex custom props; alias with
  `var(--color-*)` directly (no rounding drift, one source of truth).
- Dark is provided for completeness; chat renders light-only today (Mars scopes
  dark via `.dag-canvas`, not `.dark`).

### 2b. `cn()` util — create `ui/src/lib/utils.ts` (new dir `src/lib/`):

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

### 2c. Alias — **already done**. `@/*` → `src/*` resolves in tsconfig.json and
vite.config.ts. `@/lib/utils` will resolve with no config change. Skip
`vite-tsconfig-paths`. Optionally add `ui/components.json` (Brief D §4 shape) so
a future `npx shadcn add` works, but it is not required for the hand-authored
route.

### 2d. Rename fallout in ChatPage (hard-cut, same change) — because the alias
layer redefines what `muted`/`accent` mean:
1. `text-muted` → `text-muted-foreground` (10× in ChatPage). `--color-muted` is
   now a background (#F5EDE4); the old #705F50 text value now lives in
   `--muted-foreground`. Value-preserving rename.
2. `text-accent` / `bg-accent` (lines ~133, 535, 653, 841) currently resolve to
   nothing (no `--color-accent` ever existed — latent bug). Re-point the
   "colored link/active" intents to `text-primary` (iron): the underline link
   (653), active states (535, 841), and the chip (133 → `border-primary/40
   bg-primary/5`). Leave any genuine hover-surface use on shadcn `accent`.

---

## 3. AI Elements component files to create

Vendor via `npx ai-elements@latest` in a network-capable environment and commit
the generated trees; otherwise hand-author. Files land under
`ui/src/components/ai-elements/` (elements) and `ui/src/components/ui/` (base
shadcn primitives). Create in this order:

Base primitives — `ui/src/components/ui/`:
`button.tsx`, `textarea.tsx`, `collapsible.tsx`, `select.tsx`,
`dropdown-menu.tsx`, `badge.tsx`, `tooltip.tsx`, `avatar.tsx`, `scroll-area.tsx`.

AI Elements — `ui/src/components/ai-elements/`:
| file | exports / purpose |
|---|---|
| `conversation.tsx` | `Conversation`, `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton` — auto-scroll viewport on `use-stick-to-bottom`. |
| `message.tsx` | `Message`, `MessageContent`, `MessageAvatar` — role-aligned row. |
| `response.tsx` | `Response` — Streamdown wrapper (streaming-safe markdown/GFM/code). |
| `reasoning.tsx` | `Reasoning`, `ReasoningTrigger`, `ReasoningContent` — auto-open while streaming. |
| `tool.tsx` | `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, `ToolOutput` — per-tool panel with state badge. |
| `prompt-input.tsx` | `PromptInput`, `PromptInputTextarea`, `PromptInputToolbar`, `PromptInputTools`, `PromptInputButton`, `PromptInputSubmit`, `PromptInputAttachments`, `PromptInputAttachment`. |
| `actions.tsx` | `Actions`, `Action` — hover icon-button row (feedback). |
| `loader.tsx` | `Loader` — spinner for `submitted`/`streaming`. |
| `image.tsx` | image-part renderer (for image attachments). |
| `suggestion.tsx` | `Suggestions`, `Suggestion` — welcome/hero chips. |

Not needed now: `sources.tsx` (no source parts in Mars stream), `code-block.tsx`
(code renders inside `Response`). These are plain editable shadcn-style files —
edit in-repo to pick up the token layer; they consume `bg-primary`,
`text-muted-foreground`, `border-border`, `ring`, etc., which now map to Mars.

---

## 4. `MarsChatTransport` design

**File:** `ui/src/lib/mars-chat-transport.ts` (implements
`ChatTransport<UIMessage>` from `ai`).

### 4a. SSE ownership moves into a shared pub/sub (chatBuffer.ts is deleted)

Introduce a tiny delta bus that replaces `chatBuffer`'s store:

**File:** `ui/src/shared/chatDeltaBus.ts`
```ts
import type { LiveEvent } from './liveEvent'  // the LiveEvent union, relocated here
type Sub = (event: LiveEvent) => void
const subs = new Map<string, Set<Sub>>()          // threadId -> listeners
export function publishChatDelta(threadId: string, event: LiveEvent) {
  subs.get(threadId)?.forEach(cb => cb(event))
}
export function subscribeChatDelta(threadId: string, cb: Sub): () => void {
  let set = subs.get(threadId); if (!set) subs.set(threadId, (set = new Set()))
  set.add(cb)
  return () => { set!.delete(cb); if (set!.size === 0) subs.delete(threadId) }
}
```
Move the `LiveEvent` union out of the deleted `chatBuffer.ts` into
`ui/src/shared/liveEvent.ts` (it stays as the SSE wire type). `SseInvalidator`'s
`chat-delta` handler (lines 88–100) is repointed from
`pushLiveEvent(threadId, event)` to `publishChatDelta(threadId, event)`. The
single global `EventSource` stays where it is — the transport does **not** open
a second stream; it demultiplexes by `threadId` via `subscribeChatDelta`.

### 4b. `LiveEvent` → `UIMessageChunk` mapping (the single normaliser)

Maintain per-run local state: one `textId` for the open text run, a fresh
`reasoningId` per thinking block, `tool_use.id` as `toolCallId`.

| incoming `LiveEvent` | chunks emitted | resulting part |
|---|---|---|
| *(stream opens)* | `{type:'start'}`, `{type:'start-step'}` | begins assistant msg |
| `text` (first non-empty) | `{type:'text-start',id:textId}`, `{type:'text-delta',id:textId,delta:text}` | `text` part (streaming) |
| `text` (subsequent) | `{type:'text-delta',id:textId,delta:text}` (reuse `textId`; **append**, not replace) | same part grows |
| `thinking` | `{type:'reasoning-start',id:rId}`, `{type:'reasoning-delta',id:rId,delta:thinking}`, `{type:'reasoning-end',id:rId}` (whole block; fresh `rId`) | `reasoning` part |
| `tool_use` | `{type:'tool-input-start',toolCallId:id,toolName:name}`, `{type:'tool-input-available',toolCallId:id,toolName:name,input}` | `tool-<name>`, `input-available` |
| `tool_result` (`isError=false`) | close open text run (`text-end`) if any, then `{type:'tool-output-available',toolCallId:tool_use_id,output:content}` | tool → `output-available` |
| `tool_result` (`isError=true`) | `{type:'tool-output-error',toolCallId:tool_use_id,errorText:<stringified content>}` | tool → `output-error` |
| `result` | `{type:'text-end',id:textId}` if open, `{type:'finish-step'}`, `{type:'finish'}`, then **close stream**. Usage rides as message metadata or a `data-usage` data part. | finalises msg |
| `error` | `{type:'error',errorText:message}`, `{type:'finish'}`, then **close stream** | surfaces via `useChat.error` |

Field-vocabulary reconciliation (the whole reason the transport is the single
normaliser): the **live** `LiveEvent` union uses `name`/`thinking` and split
`tool_use`/`tool_result` keyed by `id`/`tool_use_id`; the **persisted**
`ChatSegment` union uses `toolName`/`text` with `result` folded onto `tool_use`.
Both must land on one `UIMessage.parts` shape. Carry over `groupMessageSegments`
rules exactly: fold `tool_result` into the preceding `tool_use`, drop empty
thinking, drop empty text (`seg.text.length === 0`). `text` is **block-append,
not char-delta** — feed each block as one `text-delta`; do not diff.

### 4c. `sendMessages(options)` lifecycle

1. Extract last user `UIMessage` from `options.messages`; flatten text parts →
   `content`; map file parts → already-uploaded `attachmentIds`. Resolve
   `threadId` (transport is bound to one thread / from `options.chatId`). Grab
   `options.abortSignal`.
2. **Subscribe before posting** via `subscribeChatDelta(threadId, cb)` (avoids
   the race where `result` lands before attach). Filter is implicit — the bus is
   already keyed by `threadId`.
3. Emit `start`, `start-step`.
4. `await postChatMessage(threadId, content, projectId, attachmentIds)` (real
   export — **not** `sendChatMessage`; fire-and-forget, resolves on enqueue). On
   `ApiError`: emit `error` + `finish`, close. A **409 "already running"** is a
   valid race — continue reading the existing run's stream instead of erroring.
5. Pump deltas → chunks per §4b, maintaining `textId`/`reasoningId`/open-tool
   state; enqueue into the `ReadableStream` controller.
6. Terminate on `result` **or** `error`: emit closing chunks, unsubscribe,
   `controller.close()`.
7. **Stop/abort:** wire `options.abortSignal` `abort` → `stopChatThread(threadId)`,
   unsubscribe, emit a trailing `finish` so `useChat` settles. A late `result`
   after stop is ignored (already unsubscribed). This maps the AI Elements stop
   button onto the daemon.
8. **History / reconcile:** deltas are best-effort; `fetchChatThread(threadId)`
   is authoritative. On unclean close or SSE reconnect (`SseInvalidator` fires
   `hello` → invalidates `['chat-thread']`), trigger a `fetchChatThread` refetch
   to reconcile missed deltas. Persisted `ChatMessage.segments` map to
   `UIMessage.parts` through the **same** normaliser (§4b), so history and live
   render identically.
9. **`reconnectToStream()` returns `null`** — daemon has no resumable-stream
   endpoint (that endpoint is the explicit follow-up). Reconnection safety net is
   the `fetchChatThread` refetch above.
10. **`regenerate`** = a fresh `postChatMessage` turn (no daemon regenerate
    route). True drop-last-assistant regeneration is out of scope.

Integration points touched: `api.ts` (`postChatMessage`, `stopChatThread`,
`uploadAttachment`, `fetchChatThread`, `createChatThread` — unchanged, just
called by the transport), `SseInvalidator.tsx` (repoint handler to
`publishChatDelta`).

---

## 5. ChatPage rewire

### 5a. Component → AI Element swaps
| Mars symbol | Becomes | Note |
|---|---|---|
| `MessageList` (:950) | `Conversation` + `ConversationContent` + `ConversationScrollButton` | drops bespoke 120px `distanceFromBottom` scroll-pin and the live-buffer swap. |
| `ChatMessageBubble` (:687) | `Message` + `MessageContent` | role→`from`; `assistantHasNonAlert` double-box guard → `variant="flat"`. |
| text segment render (:720-726) | `Response` | drop hand-rolled `Markdown`+`remarkGfm`; verify GFM/table parity. |
| `ThinkingBlock` (:331) | `Reasoning` + `ReasoningTrigger` + `ReasoningContent` | **DELETE** ThinkingBlock. |
| `ToolDetail` (:261) | `Tool` + `ToolHeader` + `ToolContent` + `ToolInput` + `ToolOutput` | map state from `isError`/`result` presence. **DELETE** ToolDetail. |
| `JsonBox` (:254) | built-in `ToolInput`/`ToolOutput` | **DELETE** JsonBox. |
| `ToolActivityGroup` (:305) | N × `Tool` (option a: drop group) or thin Mars shell around N `Tool` (option b) | pick one; `toolGroupLabel` survives only under (b). Default: option a unless grouping is visually required. |
| `LiveAssistantBubble` (:884) | nothing — in-flight msg is a `UIMessage` w/ `status==='streaming'` + `Loader` | **DELETE** entirely. |
| `FeedbackControls` (:423) | `Actions` + `Action` (restyle only) | **logic body kept verbatim** (see 5b). |
| `AttachmentDisplay` (:608) | `Image` for image parts; audio/video/file stay bespoke | `resolveMediaKind` (:592) retained. |
| composer attachment chips (:1599-1633) | `PromptInputAttachments` / `PromptInputAttachment` | object-URL lifecycle stays Mars-owned. |
| `Composer` (:1337) | `PromptInput` + `PromptInputTextarea` + `PromptInputToolbar` + `PromptInputSubmit` (+ `PromptInputButton`) | all send/stop/upload/mic/drag/paste logic preserved. |
| `HeroComposer` (:1146) | `PromptInput` (larger) | `createAndSend` override kept. |
| `HeroSuggestions` (:128) / `WelcomeState` (:1098) | `Suggestions` + `Suggestion` + `ConversationEmptyState` | alert chip (:130-143) stays bespoke. |
| `groupMessageSegments` (:182) / `FlatSegment` (:162) | relocated into the transport normaliser | logic relocates, does not vanish. |

### 5b. Preserved verbatim behind new chrome (logic-bearing)
- Composer send mutation (:1408-1436): `uploadAttachment` → `postChatMessage`;
  `onSuccess` clears text/attachments/voiceBlob + invalidates
  `['chat-thread']`/`['chat-threads']`; inputs survive failure. Wired into the
  transport `sendMessages` path.
- Stop mutation (:1438): `stopChatThread` + invalidations; Send↔Stop toggle →
  `PromptInputSubmit status`.
- Override send (:1452, :2553, root :2337): projection-thread first message →
  `createAndSend`.
- `FeedbackControls` full body (:423-586): optimistic `localRating`/`localNote`,
  `setMessageFeedback`/`clearMessageFeedback`, toggle-off, down→note-input,
  revert-on-error, SSE resync `useEffect` (:433). Only buttons restyle to
  `Action`.
- Attachment lifecycle (:1377-1406): object-URL create/revoke, leak cleanup.
- Mic / MediaRecorder / Web Speech (:1510-1580) → `PromptInputButton`.
- Drag-drop / paste (:1485-1507).

### 5c. Stays (not AI Elements — untouched)
- `AlertCard` / `AlertCardFromSegment` (:354) and the `alert` ChatSegment
  variant — action-queue projection; `Message`/`Response` must **not** wrap it.
- `ThreadSidebar` (:1819), `ThreadItem` (:789), delete-with-undo toast, history
  accordion, `QueueThreadRow`, `QueueThreadDetail`, `mergeSidebarEntries`,
  `ContextRail`, `WhileYouWereAwayPanel`, `HeroEmptyState` layout,
  `readAqStateFromUrl`/`writeAqStateToUrl`, breakpoints, `handleQueueAction`.
- `ChatResponseError` (:661) and the `result` usage footer (:735-748,
  `formatDuration`) — no AI Element covers them; keep bespoke.

### 5d. Hard-cut DELETE list (no shim)
- `ui/src/shared/chatBuffer.ts` **entirely** (`LiveBuffer`, `LiveEvent` moves to
  `liveEvent.ts`, `applyLiveEvent`, `pushLiveEvent`, `clearLiveBuffer`,
  `getLiveBuffer`, `useLiveBuffer`).
- `LiveAssistantBubble` (:870-938) + `LiveAssistantBubbleProps`.
- Live-buffer plumbing in `MessageList`: `useLiveBuffer` (:970),
  `doneMessageCountRef` swap effect (:977-1002), `showLive`/`liveBuffer`
  branches (:1029, :1040-1049), `liveBuffer?.text.length` scroll dep (:1014).
- Root `useLiveBuffer` (:2364) + `liveBufferForThread` in `hasMessages` (:2368),
  welcome-hide-on-stream (:2364-2368).
- `ThinkingBlock` (:331), `ToolActivityGroup` (:305), `ToolDetail` (:261),
  `JsonBox` (:254).
- Hand-rolled `Markdown`+`remarkGfm` text render (:720-726); `react-markdown` +
  `remark-gfm` deps (grep for other consumers first).
- `refetchInterval` 2000ms polling fallback (:962-966, :2357-2360) — the
  transport owns liveness; delete.
- `pushLiveEvent` call in `SseInvalidator.tsx` → repointed to
  `publishChatDelta` (not dual-written).

---

## 6. Test-update list

| test file | change |
|---|---|
| `ui/src/shared/chatBuffer.test.ts` | **DELETE** — module removed. Add `ui/src/shared/chatDeltaBus.test.ts` covering subscribe/publish/unsubscribe + threadId isolation. |
| `ui/src/shared/SseInvalidator.test.tsx` | update the `chat-delta` assertion from `pushLiveEvent` to `publishChatDelta`; keep other channel assertions. |
| `ui/src/pages/ChatPage.test.tsx` | rewrite render assertions against AI Elements (`Message`/`Response`/`Reasoning`/`Tool`) instead of `ChatMessageBubble`/`ThinkingBlock`/`ToolDetail`; drop `LiveAssistantBubble`/live-buffer assertions; assert streaming via `useChat` status. |
| `ui/src/pages/ChatPageResolved.test.tsx` | update to persisted-history → `UIMessage.parts` path (normaliser); keep alert-card-not-wrapped assertion. |
| `ui/src/pages/ChatHero.test.tsx` | hero composer → `PromptInput`; suggestions → `Suggestion`; `createAndSend` override preserved. |
| `ui/src/pages/ChatPage.composer.test.tsx` | composer send/stop/upload/mic/drag/paste against `PromptInput*` chrome; assert `postChatMessage`/`stopChatThread`/`uploadAttachment` still called with same args. |
| `ui/src/pages/ChatThreadDelete.test.tsx` | likely unchanged (sidebar untouched) — run to confirm; adjust only if selectors moved. |
| `ui/src/pages/ChatPageSidebarMerge.test.tsx` | unchanged (sidebar untouched) — confirm green. |
| `ui/src/widgets/chat/*` (AlertCard, QueueThreadDetail, QueueThreadRow, queueThreads) | unchanged — AlertCard/queue projections stay; confirm green. |
| **new** `ui/src/lib/mars-chat-transport.test.ts` | unit-test the `LiveEvent`→`UIMessageChunk` mapping table (text append, thinking block, tool_use/tool_result pairing, `result`/`error` termination, 409 continue, abort→stop). |

Add a lightweight AI Elements smoke test only if the vendored components need a
render guard; otherwise rely on ChatPage tests.

---

## 7. Ordered, independently tsc-checkable steps

Each step should leave `npm --prefix ui run build` / `tsc` green (or is a
mechanical file add). Verify per step with
`(cd /Users/ib472e5l/project/perso/mars-shadcn-wt/ui && npx tsc --noEmit)` and
the vitest suite.

- **Step 1 — Dependencies.** Run the §1 install into `ui`. tsc green (nothing
  imports the new deps yet).
- **Step 2 — cn() + token layer.** Create `ui/src/lib/utils.ts`; append the §2a
  CSS to `index.css`. Alias already resolves. tsc green; app still renders on
  Mars palette. (Defer the §2d ChatPage renames to Step 7 so ChatPage compiles
  untouched here.)
- **Step 3 — Base shadcn primitives.** Create `ui/src/components/ui/*` (§3
  list). tsc green; unused but valid.
- **Step 4 — AI Elements.** Create `ui/src/components/ai-elements/*` (§3). tsc
  green; unused but valid. (Vendor via CLI if network available, else
  hand-author.)
- **Step 5 — Delta bus + LiveEvent relocation.** Add
  `ui/src/shared/liveEvent.ts` (the `LiveEvent` union) and
  `ui/src/shared/chatDeltaBus.ts`. Repoint `SseInvalidator.tsx` to
  `publishChatDelta`. **Do not delete `chatBuffer.ts` yet** — repoint its
  `LiveEvent` import to `liveEvent.ts` so both compile. tsc green; update
  `SseInvalidator.test.tsx`.
- **Step 6 — MarsChatTransport.** Add `ui/src/lib/mars-chat-transport.ts`
  (§4) + `mars-chat-transport.test.ts`. Consumes `chatDeltaBus` + `api.ts`. tsc
  green; transport unit tests pass. ChatPage not yet wired.
- **Step 7 — ChatPage rewire (the big cut).** Swap components to AI Elements
  (§5a), wire `useChat({ transport })`, preserve logic (§5b), apply §2d renames,
  perform the entire §5d DELETE list (including `chatBuffer.ts` and
  `LiveAssistantBubble`), remove the polling `refetchInterval`. Update
  `ChatPage.test.tsx`, `ChatPageResolved.test.tsx`, `ChatHero.test.tsx`,
  `ChatPage.composer.test.tsx`; delete `chatBuffer.test.ts`, add
  `chatDeltaBus.test.ts`. tsc + full vitest green.
- **Step 8 — Dependency cleanup.** Grep for remaining `react-markdown` /
  `remark-gfm` consumers; if none, remove both from `ui/package.json` and
  reinstall. Run `knip` to catch orphaned exports from the cut. tsc + build +
  vitest green.

Verification per step: `(cd .../ui && npx tsc --noEmit)` twice (transient
node_modules can produce phantom TS2307), plus `npm --prefix ui run test` for
the touched suites; final `npm --prefix ui run build`.
