import { describe, expect, it } from 'bun:test';
import { TaskIdSchema, TaskSchema, TaskStateSchema } from './task.ts';

const validId = '7f3a91c2-add-oauth-callback';
const validFeatureId = 'a1b2c3d4-mvp-bootstrap';

describe('TaskIdSchema', () => {
  it('accepts a canonical <8hex>-<slug> id', () => {
    expect(() => TaskIdSchema.parse(validId)).not.toThrow();
  });

  it('rejects a uuid prefix that is too short', () => {
    expect(() => TaskIdSchema.parse('7f3a91c-add-x')).toThrow();
  });

  it('rejects uppercase in the slug', () => {
    expect(() => TaskIdSchema.parse('7f3a91c2-Add-x')).toThrow();
  });

  it('rejects a slug starting with a hyphen', () => {
    expect(() => TaskIdSchema.parse('7f3a91c2--leading')).toThrow();
  });
});

describe('TaskStateSchema', () => {
  it('accepts the four states', () => {
    for (const s of ['to_refine', 'ready_for_execution', 'awaiting_human', 'done']) {
      expect(() => TaskStateSchema.parse(s)).not.toThrow();
    }
  });

  it('rejects in_progress (it is derived per §3.2, not stored)', () => {
    expect(() => TaskStateSchema.parse('in_progress')).toThrow();
  });
});

describe('TaskSchema', () => {
  it('accepts a minimal valid task', () => {
    expect(() =>
      TaskSchema.parse({
        id: validId,
        featureId: validFeatureId,
        title: 'Add OAuth callback',
        deps: [],
        acceptance: ['returns 302 to /home on success'],
        state: 'ready_for_execution',
      }),
    ).not.toThrow();
  });

  it('rejects acceptance with zero items', () => {
    expect(() =>
      TaskSchema.parse({
        id: validId,
        featureId: validFeatureId,
        title: 'x',
        deps: [],
        acceptance: [],
        state: 'to_refine',
      }),
    ).toThrow();
  });

  it('rejects an empty title', () => {
    expect(() =>
      TaskSchema.parse({
        id: validId,
        featureId: validFeatureId,
        title: '',
        deps: [],
        acceptance: ['x'],
        state: 'to_refine',
      }),
    ).toThrow();
  });
});
