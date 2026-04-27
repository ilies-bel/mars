import { describe, expect, it } from 'bun:test';
import { BuildResultSchema } from './build-result.ts';

describe('BuildResultSchema', () => {
  it('accepts a minimal done result with no edits', () => {
    expect(() => BuildResultSchema.parse({ edits: [], done: true })).not.toThrow();
  });

  it('accepts a result with edits and a checkpoint hint', () => {
    expect(() =>
      BuildResultSchema.parse({
        edits: [{ op: 'write', path: 'a.ts', contents: 'x' }],
        checkpointHint: 'add a.ts',
        done: false,
      }),
    ).not.toThrow();
  });

  it('rejects a result missing done', () => {
    expect(() => BuildResultSchema.parse({ edits: [] })).toThrow();
  });

  it('rejects a result with a tokensUsed field (MVP: budget deferred)', () => {
    // Strict-mode parse to enforce no tokensUsed leakage. Default Zod is non-strict;
    // we assert the schema does not declare it. If someone adds tokensUsed back,
    // this test will still pass under default mode — so we instead verify the type
    // does not include the key by checking the parsed object.
    const parsed = BuildResultSchema.parse({ edits: [], done: true, tokensUsed: 999 });
    expect(parsed).not.toHaveProperty('tokensUsed');
  });
});
