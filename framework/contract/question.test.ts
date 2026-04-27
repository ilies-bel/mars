import { describe, expect, it } from 'bun:test';
import { QuestionSchema } from './question.ts';

const validTaskId = '7f3a91c2-add-oauth-callback';

describe('QuestionSchema', () => {
  it('accepts a minimal refine_feature question', () => {
    expect(() =>
      QuestionSchema.parse({
        questionKind: 'refine_feature',
        taskIds: [validTaskId],
        prompt: 'Which auth provider should we use?',
      }),
    ).not.toThrow();
  });

  it('accepts a question with options and answer', () => {
    expect(() =>
      QuestionSchema.parse({
        questionKind: 'unblock_task',
        taskIds: [validTaskId],
        prompt: 'Pick one',
        options: ['a', 'b'],
        answer: 'a',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown questionKind', () => {
    expect(() =>
      QuestionSchema.parse({
        questionKind: 'random',
        taskIds: [validTaskId],
        prompt: 'x',
      }),
    ).toThrow();
  });

  it('rejects an empty prompt', () => {
    expect(() =>
      QuestionSchema.parse({ questionKind: 'refine_feature', taskIds: [validTaskId], prompt: '' }),
    ).toThrow();
  });
});
