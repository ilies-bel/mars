import { describe, expect, it } from 'bun:test';
import { FeatureSchema, FeatureWithTasksSchema } from './feature.ts';

const validFeatureId = 'a1b2c3d4-mvp-bootstrap';
const validTaskId = '7f3a91c2-add-oauth-callback';
const baseTimestamp = '2026-04-27T22:00:00.000Z';

const validFeature = {
  id: validFeatureId,
  goal: 'Bootstrap Mars MVP',
  status: 'ready' as const,
  origin: 'user' as const,
  taskCount: 0,
  readyTaskCount: 0,
  createdAt: baseTimestamp,
  updatedAt: baseTimestamp,
};

describe('FeatureSchema', () => {
  it('accepts a minimal valid feature', () => {
    expect(() => FeatureSchema.parse(validFeature)).not.toThrow();
  });

  it('rejects a negative taskCount', () => {
    expect(() => FeatureSchema.parse({ ...validFeature, taskCount: -1 })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => FeatureSchema.parse({ ...validFeature, status: 'pending' })).toThrow();
  });
});

describe('FeatureWithTasksSchema', () => {
  it('accepts a feature with one valid task', () => {
    expect(() =>
      FeatureWithTasksSchema.parse({
        ...validFeature,
        tasks: [
          {
            id: validTaskId,
            featureId: validFeatureId,
            title: 'Add OAuth callback',
            deps: [],
            acceptance: ['returns 302'],
            state: 'ready_for_execution',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a feature whose tasks array contains a non-task object', () => {
    expect(() =>
      FeatureWithTasksSchema.parse({ ...validFeature, tasks: [{ id: validTaskId }] }),
    ).toThrow();
  });
});
