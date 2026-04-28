import { describe, expect, it } from 'bun:test';
import { InboxItemSchema, InboxItemPayloadSchema } from './inbox-item.ts';

const validId = '7f3a91c2-needs-decision';
const validTaskId = '7f3a91c2-add-oauth-callback';
const now = '2026-04-28T12:00:00Z';

const baseQuestionItem = {
  id: validId,
  kind: 'question' as const,
  category: 'defect' as const,
  priority: 'blocker' as const,
  title: 'Which provider?',
  body: 'Pick one of GitHub, Google, custom.',
  context: { relatedTaskIds: [validTaskId] },
  state: 'open' as const,
  raisedBy: 'agent-7f3a91c2',
  raisedAt: now,
  payload: {
    kind: 'question' as const,
    question: {
      questionKind: 'refine_feature' as const,
      taskIds: [validTaskId],
      prompt: 'Which auth provider?',
    },
  },
};

describe('InboxItemSchema', () => {
  it('accepts a minimal question item', () => {
    expect(() => InboxItemSchema.parse(baseQuestionItem)).not.toThrow();
  });

  it('accepts an action item with verifyHint', () => {
    expect(() =>
      InboxItemSchema.parse({
        ...baseQuestionItem,
        kind: 'action',
        payload: {
          kind: 'action',
          instruction: 'Rotate the GH token',
          verifyHint: 'check `gh auth status`',
        },
      }),
    ).not.toThrow();
  });

  it('accepts a decision item with at least one option', () => {
    expect(() =>
      InboxItemSchema.parse({
        ...baseQuestionItem,
        kind: 'decision',
        category: 'gate',
        payload: {
          kind: 'decision',
          options: [
            { id: 'a', label: 'Option A', consequence: 'Faster' },
            { id: 'b', label: 'Option B' },
          ],
        },
      }),
    ).not.toThrow();
  });

  it('rejects mismatched kind/payload.kind', () => {
    expect(() =>
      InboxItemSchema.parse({
        ...baseQuestionItem,
        kind: 'action',
      }),
    ).toThrow();
  });

  it('rejects a decision item with zero options', () => {
    expect(() =>
      InboxItemSchema.parse({
        ...baseQuestionItem,
        kind: 'decision',
        payload: { kind: 'decision', options: [] },
      }),
    ).toThrow();
  });

  it('rejects a resolved item without resolvedAt', () => {
    expect(() =>
      InboxItemSchema.parse({
        ...baseQuestionItem,
        state: 'resolved',
        resolution: 'github',
      }),
    ).toThrow();
  });

  it('accepts a resolved item with resolvedAt', () => {
    expect(() =>
      InboxItemSchema.parse({
        ...baseQuestionItem,
        state: 'resolved',
        resolvedAt: now,
        resolution: 'github',
      }),
    ).not.toThrow();
  });

  it('rejects an empty title', () => {
    expect(() =>
      InboxItemSchema.parse({ ...baseQuestionItem, title: '' }),
    ).toThrow();
  });

  it('rejects an unknown priority', () => {
    expect(() =>
      InboxItemSchema.parse({ ...baseQuestionItem, priority: 'urgent' }),
    ).toThrow();
  });

  it('rejects an unknown rootCause', () => {
    expect(() =>
      InboxItemSchema.parse({ ...baseQuestionItem, rootCause: 'vibes' }),
    ).toThrow();
  });

  it('rejects a malformed id', () => {
    expect(() =>
      InboxItemSchema.parse({ ...baseQuestionItem, id: 'not-an-id' }),
    ).toThrow();
  });
});

describe('InboxItemPayloadSchema', () => {
  it('discriminates on kind', () => {
    const parsed = InboxItemPayloadSchema.parse({
      kind: 'action',
      instruction: 'do the thing',
    });
    expect(parsed.kind).toBe('action');
  });
});
