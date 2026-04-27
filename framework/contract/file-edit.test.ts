import { describe, expect, it } from 'bun:test';
import { FileEditSchema } from './file-edit.ts';

describe('FileEditSchema', () => {
  it('accepts a write edit', () => {
    expect(() =>
      FileEditSchema.parse({ op: 'write', path: 'src/a.ts', contents: 'hello' }),
    ).not.toThrow();
  });

  it('accepts a patch edit', () => {
    expect(() =>
      FileEditSchema.parse({ op: 'patch', path: 'src/a.ts', diff: '@@ -1 +1 @@' }),
    ).not.toThrow();
  });

  it('accepts a delete edit', () => {
    expect(() => FileEditSchema.parse({ op: 'delete', path: 'src/a.ts' })).not.toThrow();
  });

  it('accepts a rename edit', () => {
    expect(() =>
      FileEditSchema.parse({ op: 'rename', from: 'src/a.ts', to: 'src/b.ts' }),
    ).not.toThrow();
  });

  it('rejects an unknown op', () => {
    expect(() => FileEditSchema.parse({ op: 'merge', path: 'src/a.ts' })).toThrow();
  });

  it('rejects an empty path', () => {
    expect(() => FileEditSchema.parse({ op: 'delete', path: '' })).toThrow();
  });

  it('rejects a write missing contents', () => {
    expect(() => FileEditSchema.parse({ op: 'write', path: 'src/a.ts' })).toThrow();
  });
});
