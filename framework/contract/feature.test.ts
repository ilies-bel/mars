import { describe, expect, it } from 'bun:test';
import { PlanSchema, PlanWithTasksSchema } from './plan.ts';

const validPlanId = 'a1b2c3d4-mvp-bootstrap';
const validTaskId = '7f3a91c2-add-oauth-callback';
const baseTimestamp = '2026-04-27T22:00:00.000Z';

const validPlan = {
  id: validPlanId,
  goal: 'Bootstrap Mars MVP',
  status: 'ready' as const,
  origin: 'user' as const,
  taskCount: 0,
  readyTaskCount: 0,
  createdAt: baseTimestamp,
  updatedAt: baseTimestamp,
};

describe('PlanSchema', () => {
  it('accepts a minimal valid plan', () => {
    expect(() => PlanSchema.parse(validPlan)).not.toThrow();
  });

  it('rejects a negative taskCount', () => {
    expect(() => PlanSchema.parse({ ...validPlan, taskCount: -1 })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => PlanSchema.parse({ ...validPlan, status: 'pending' })).toThrow();
  });
});

describe('PlanWithTasksSchema', () => {
  it('accepts a plan with one valid task', () => {
    expect(() =>
      PlanWithTasksSchema.parse({
        ...validPlan,
        tasks: [
          {
            id: validTaskId,
            planId: validPlanId,
            title: 'Add OAuth callback',
            deps: [],
            acceptance: ['returns 302'],
            state: 'ready_for_execution',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a plan whose tasks array contains a non-task object', () => {
    expect(() =>
      PlanWithTasksSchema.parse({ ...validPlan, tasks: [{ id: validTaskId }] }),
    ).toThrow();
  });
});
