import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { SqliteStore } from '../src/index.js';

describe('SqliteStore path validation', () => {
  it('throws a TypeError for undefined path before any file I/O', () => {
    expect(() => new SqliteStore(undefined as unknown as string)).toThrow(/non-empty string/);
    expect(fs.existsSync(nodePath.join(process.cwd(), 'undefined'))).toBe(false);
    expect(fs.existsSync(nodePath.join(process.cwd(), 'undefined-shm'))).toBe(false);
    expect(fs.existsSync(nodePath.join(process.cwd(), 'undefined-wal'))).toBe(false);
  });

  it('throws a TypeError for empty string path before any file I/O', () => {
    expect(() => new SqliteStore('')).toThrow(/non-empty string/);
    expect(fs.existsSync(nodePath.join(process.cwd(), 'undefined'))).toBe(false);
    expect(fs.existsSync(nodePath.join(process.cwd(), 'undefined-shm'))).toBe(false);
    expect(fs.existsSync(nodePath.join(process.cwd(), 'undefined-wal'))).toBe(false);
  });

  it('includes the offending value in the error message for undefined', () => {
    expect(() => new SqliteStore(undefined as unknown as string)).toThrow(
      'SqliteStore: path must be a non-empty string, received undefined',
    );
  });

  it('includes the offending value in the error message for empty string', () => {
    expect(() => new SqliteStore('')).toThrow(
      "SqliteStore: path must be a non-empty string, received ''",
    );
  });
});
