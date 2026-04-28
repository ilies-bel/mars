import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxItem } from '../contract/inbox-item.ts';
import type { InboxItemDraft, InboxStore } from './inbox-store.ts';
import { JsonlInboxStore } from './jsonl-inbox-store.ts';
import { MemoryInboxStore } from './memory-inbox-store.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TASK_A = '7f3a91c2-add-oauth-callback';
const TASK_B = '7f3a91c2-write-oauth-tests';

function questionDraft(overrides: Partial<InboxItemDraft> = {}): InboxItemDraft {
  return {
    kind: 'question',
    category: 'defect',
    title: 'Which provider?',
    body: 'Pick GitHub, Google, or custom.',
    context: { relatedTaskIds: [TASK_A] },
    raisedBy: 'agent-7f3a91c2',
    payload: {
      kind: 'question',
      question: {
        questionKind: 'refine_feature',
        taskIds: [TASK_A],
        prompt: 'Which auth provider?',
      },
    },
    ...overrides,
  };
}

function actionDraft(overrides: Partial<InboxItemDraft> = {}): InboxItemDraft {
  return {
    kind: 'action',
    category: 'defect',
    title: 'Rotate the API key',
    body: 'Production key was logged; rotate and update vault.',
    context: {},
    raisedBy: 'orchestrator',
    payload: {
      kind: 'action',
      instruction: 'Run `vault rotate prod-api-key`.',
    },
    ...overrides,
  };
}

function decisionDraft(overrides: Partial<InboxItemDraft> = {}): InboxItemDraft {
  return {
    kind: 'decision',
    category: 'defect',
    title: 'Pick a logging library',
    body: 'Three retro clusters point at the same gap.',
    context: {},
    raisedBy: 'system',
    payload: {
      kind: 'decision',
      options: [
        { id: 'pino', label: 'pino' },
        { id: 'winston', label: 'winston' },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared contract suite — runs against every adapter
// ---------------------------------------------------------------------------

interface AdapterHarness {
  name: string;
  setup: () => Promise<{ store: InboxStore; cleanup: () => Promise<void> }>;
}

const adapters: AdapterHarness[] = [
  {
    name: 'MemoryInboxStore',
    setup: async () => ({
      store: new MemoryInboxStore({ idPrefix: '7f3a91c2' }),
      cleanup: async () => {
        // nothing to clean for in-memory
      },
    }),
  },
  {
    name: 'JsonlInboxStore',
    setup: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mars-inbox-'));
      const path = join(dir, 'inbox.jsonl');
      const store = new JsonlInboxStore({ path, idPrefix: '7f3a91c2' });
      return {
        store,
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

for (const adapter of adapters) {
  describe(`InboxStore contract — ${adapter.name}`, () => {
    let store: InboxStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const harness = await adapter.setup();
      store = harness.store;
      cleanup = harness.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    // -----------------------------------------------------------------------
    // append
    // -----------------------------------------------------------------------

    describe('append', () => {
      it('returns the persisted item with id, state, raisedAt, priority filled', async () => {
        const item = await store.append(questionDraft());
        expect(item.id).toBeTruthy();
        expect(item.state).toBe('open');
        expect(item.raisedAt).toBeTruthy();
        expect(['blocker', 'high', 'normal', 'low']).toContain(item.priority);
      });

      it('produces unique ids across appends', async () => {
        const a = await store.append(questionDraft());
        const b = await store.append(questionDraft());
        const c = await store.append(actionDraft());
        const ids = new Set([a.id, b.id, c.id]);
        expect(ids.size).toBe(3);
      });

      it('preserves draft fields verbatim', async () => {
        const draft = questionDraft({ title: 'Custom title' });
        const item = await store.append(draft);
        expect(item.title).toBe('Custom title');
        expect(item.kind).toBe('question');
        expect(item.payload.kind).toBe('question');
        expect(item.raisedBy).toBe('agent-7f3a91c2');
      });
    });

    // -----------------------------------------------------------------------
    // get
    // -----------------------------------------------------------------------

    describe('get', () => {
      it('returns null for unknown id', async () => {
        const result = await store.get('nope-does-not-exist');
        expect(result).toBeNull();
      });

      it('returns the appended item by id', async () => {
        const created = await store.append(questionDraft());
        const fetched = await store.get(created.id);
        expect(fetched).not.toBeNull();
        expect(fetched?.id).toBe(created.id);
        expect(fetched?.title).toBe(created.title);
      });
    });

    // -----------------------------------------------------------------------
    // list + query filters
    // -----------------------------------------------------------------------

    describe('list', () => {
      it('returns empty when no items', async () => {
        const items = await store.list();
        expect(items).toEqual([]);
      });

      it('returns all items without a query', async () => {
        await store.append(questionDraft());
        await store.append(actionDraft());
        await store.append(decisionDraft());
        const items = await store.list();
        expect(items.length).toBe(3);
      });

      it('filters by kind', async () => {
        await store.append(questionDraft());
        await store.append(actionDraft());
        const questions = await store.list({ kind: 'question' });
        expect(questions.length).toBe(1);
        expect(questions[0]?.kind).toBe('question');
      });

      it('filters by state', async () => {
        const q = await store.append(questionDraft());
        await store.append(actionDraft());
        await store.answer(q.id, 'github');
        const open = await store.list({ state: 'open' });
        const resolved = await store.list({ state: 'resolved' });
        expect(open.length).toBe(1);
        expect(resolved.length).toBe(1);
      });

      it('filters by category', async () => {
        await store.append(questionDraft({ category: 'defect' }));
        await store.append(questionDraft({ category: 'gate' }));
        const gates = await store.list({ category: 'gate' });
        expect(gates.length).toBe(1);
      });

      it('filters by taskId via context.relatedTaskIds', async () => {
        await store.append(questionDraft({ context: { relatedTaskIds: [TASK_A] } }));
        await store.append(questionDraft({ context: { relatedTaskIds: [TASK_B] } }));
        const forA = await store.list({ taskId: TASK_A });
        expect(forA.length).toBe(1);
      });

      it('AND-combines multiple filters', async () => {
        await store.append(questionDraft({ category: 'defect' }));
        await store.append(questionDraft({ category: 'gate' }));
        await store.append(actionDraft());
        const matches = await store.list({ kind: 'question', category: 'gate' });
        expect(matches.length).toBe(1);
      });
    });

    // -----------------------------------------------------------------------
    // answer (question only)
    // -----------------------------------------------------------------------

    describe('answer', () => {
      it('marks a question as resolved with the answer text', async () => {
        const q = await store.append(questionDraft());
        await store.answer(q.id, 'github');
        const after = await store.get(q.id);
        expect(after?.state).toBe('resolved');
        expect(after?.resolution).toBe('github');
        expect(after?.resolvedAt).toBeTruthy();
      });

      it('records optional rootCause and resolutionNote', async () => {
        const q = await store.append(questionDraft());
        await store.answer(q.id, 'github', 'missing_context', {
          kind: 'harness_fix',
          notes: 'tightened planner prompt',
          commitRef: 'abc1234',
        });
        const after = await store.get(q.id);
        expect(after?.rootCause).toBe('missing_context');
        expect(after?.resolutionNote?.kind).toBe('harness_fix');
        expect(after?.resolutionNote?.commitRef).toBe('abc1234');
      });

      it('throws on action items', async () => {
        const a = await store.append(actionDraft());
        await expect(store.answer(a.id, 'done')).rejects.toThrow();
      });

      it('throws on unknown id', async () => {
        await expect(store.answer('does-not-exist', 'whatever')).rejects.toThrow();
      });

      it('throws when item is already resolved', async () => {
        const q = await store.append(questionDraft());
        await store.answer(q.id, 'github');
        await expect(store.answer(q.id, 'google')).rejects.toThrow();
      });
    });

    // -----------------------------------------------------------------------
    // resolve (action only)
    // -----------------------------------------------------------------------

    describe('resolve', () => {
      it('marks an action as resolved with the note', async () => {
        const a = await store.append(actionDraft());
        await store.resolve(a.id, 'rotated and updated vault');
        const after = await store.get(a.id);
        expect(after?.state).toBe('resolved');
        expect(after?.resolution).toBe('rotated and updated vault');
      });

      it('throws on question items', async () => {
        const q = await store.append(questionDraft());
        await expect(store.resolve(q.id, 'note')).rejects.toThrow();
      });

      it('throws on unknown id', async () => {
        await expect(store.resolve('does-not-exist', 'note')).rejects.toThrow();
      });
    });

    // -----------------------------------------------------------------------
    // decide (decision only)
    // -----------------------------------------------------------------------

    describe('decide', () => {
      it('marks a decision as resolved with the chosen option id', async () => {
        const d = await store.append(decisionDraft());
        await store.decide(d.id, 'pino');
        const after = await store.get(d.id);
        expect(after?.state).toBe('resolved');
        expect(after?.resolution).toBe('pino');
      });

      it('throws when option id is not in the offered list', async () => {
        const d = await store.append(decisionDraft());
        await expect(store.decide(d.id, 'bunyan')).rejects.toThrow();
      });

      it('throws on question items', async () => {
        const q = await store.append(questionDraft());
        await expect(store.decide(q.id, 'pino')).rejects.toThrow();
      });
    });

    // -----------------------------------------------------------------------
    // dismiss (any kind)
    // -----------------------------------------------------------------------

    describe('dismiss', () => {
      it('dismisses a question item with a reason', async () => {
        const q = await store.append(questionDraft());
        await store.dismiss(q.id, 'agent should not have asked');
        const after = await store.get(q.id);
        expect(after?.state).toBe('dismissed');
        expect(after?.resolution).toBe('agent should not have asked');
      });

      it('dismisses an action item', async () => {
        const a = await store.append(actionDraft());
        await store.dismiss(a.id, 'no longer relevant');
        const after = await store.get(a.id);
        expect(after?.state).toBe('dismissed');
      });

      it('dismisses a decision item', async () => {
        const d = await store.append(decisionDraft());
        await store.dismiss(d.id, 'cluster was a false positive');
        const after = await store.get(d.id);
        expect(after?.state).toBe('dismissed');
      });

      it('throws on already-closed items', async () => {
        const q = await store.append(questionDraft());
        await store.answer(q.id, 'github');
        await expect(store.dismiss(q.id, 'never mind')).rejects.toThrow();
      });

      it('throws on unknown id', async () => {
        await expect(store.dismiss('does-not-exist', 'reason')).rejects.toThrow();
      });

      it('records optional rootCause', async () => {
        const q = await store.append(questionDraft());
        await store.dismiss(q.id, 'agent over-asked', 'ambiguous_prompt');
        const after = await store.get(q.id);
        expect(after?.rootCause).toBe('ambiguous_prompt');
      });
    });

    // -----------------------------------------------------------------------
    // recomputePriorities
    // -----------------------------------------------------------------------

    describe('recomputePriorities', () => {
      it('is callable for any task id without throwing', async () => {
        await expect(store.recomputePriorities(TASK_A)).resolves.toBeUndefined();
      });

      it('does not break list() afterwards', async () => {
        await store.append(questionDraft());
        await store.recomputePriorities(TASK_A);
        const items = await store.list();
        expect(items.length).toBe(1);
      });
    });

    // -----------------------------------------------------------------------
    // Round-trip: append → list → get returns the same shape
    // -----------------------------------------------------------------------

    describe('round-trip', () => {
      it('preserves item identity and shape across operations', async () => {
        const created = await store.append(questionDraft({ title: 'unique-title-xyz' }));
        const [listed] = await store.list({ kind: 'question' });
        const fetched = await store.get(created.id);
        expect(listed?.id).toBe(created.id);
        expect(fetched?.id).toBe(created.id);
        expect(listed?.title).toBe('unique-title-xyz');
        expect(fetched?.title).toBe('unique-title-xyz');
      });

      it('list returns copies — mutating the result does not affect the store', async () => {
        await store.append(questionDraft({ title: 'original' }));
        const [first] = await store.list();
        if (first) {
          (first as InboxItem).title = 'mutated';
        }
        const [again] = await store.list();
        expect(again?.title).toBe('original');
      });
    });
  });
}
