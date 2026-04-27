import { describe, expect, it } from 'bun:test';
import { IntentSchema } from './intent.ts';

const validPlanId = 'a1b2c3d4-mvp-bootstrap';
const validTaskId = '7f3a91c2-add-oauth-callback';
const baseTimestamp = '2026-04-27T22:00:00.000Z';

describe('IntentSchema', () => {
  it('accepts a build intent', () => {
    expect(() =>
      IntentSchema.parse({
        kind: 'build',
        result: { edits: [], done: true },
      }),
    ).not.toThrow();
  });

  it('accepts a question intent', () => {
    expect(() =>
      IntentSchema.parse({
        kind: 'question',
        question: {
          questionKind: 'unblock_task',
          taskIds: [validTaskId],
          prompt: 'how?',
        },
      }),
    ).not.toThrow();
  });

  it('accepts a review intent', () => {
    expect(() =>
      IntentSchema.parse({
        kind: 'review',
        review: { verdict: 'pass', findings: [] },
      }),
    ).not.toThrow();
  });

  it('accepts a plan intent', () => {
    expect(() =>
      IntentSchema.parse({
        kind: 'plan',
        plan: {
          id: validPlanId,
          goal: 'g',
          status: 'ready',
          origin: 'user',
          taskCount: 0,
          readyTaskCount: 0,
          createdAt: baseTimestamp,
          updatedAt: baseTimestamp,
          tasks: [],
        },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => IntentSchema.parse({ kind: 'other' })).toThrow();
  });

  it('rejects a build intent missing result', () => {
    expect(() => IntentSchema.parse({ kind: 'build' })).toThrow();
  });

  it('rejects a build intent with a question payload', () => {
    expect(() =>
      IntentSchema.parse({
        kind: 'build',
        question: { questionKind: 'unblock_task', taskIds: [validTaskId], prompt: 'x' },
      }),
    ).toThrow();
  });
});
