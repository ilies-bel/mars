import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgentTemplate } from './agent-template.ts';
import type { CompilerFinding } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, '__fixtures__');

function only(severity: CompilerFinding['severity'], findings: CompilerFinding[]) {
  return findings.filter((f) => f.severity === severity);
}

describe('validateAgentTemplate — rule 1 (file present)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'mars-compiler-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('flags a missing agents/<role>.md file as an error', async () => {
    const findings = await validateAgentTemplate('builder', tmpRoot);
    const errors = only('error', findings);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/missing/);
    expect(errors[0]?.message).toMatch(/§15.3 rule 1/);
  });
});

describe('validateAgentTemplate — rules 2-7 fixtures', () => {
  it('rule 2: flags missing frontmatter keys (outputs, tools)', async () => {
    const findings = await validateAgentTemplate(
      'builder',
      join(fixturesRoot, 'rule2-missing-frontmatter-keys'),
    );
    const errors = only('error', findings);
    const messages = errors.map((f) => f.message).join('\n');
    expect(messages).toContain("missing required key 'outputs'");
    expect(messages).toContain("missing required key 'tools'");
  });

  it('rule 3: flags a frontmatter role that does not match the filename', async () => {
    const findings = await validateAgentTemplate(
      'builder',
      join(fixturesRoot, 'rule3-role-mismatch'),
    );
    const errors = only('error', findings);
    expect(errors.some((f) => /does not match filename/.test(f.message))).toBe(true);
  });

  it('rule 4: flags inputs/outputs that violate the §15.2 contract', async () => {
    const findings = await validateAgentTemplate(
      'builder',
      join(fixturesRoot, 'rule4-inputs-mismatch'),
    );
    const errors = only('error', findings);
    const messages = errors.map((f) => f.message).join('\n');
    expect(messages).toContain("inputs 'Goal'");
    expect(messages).toContain("outputs 'Feature'");
    expect(messages).toContain('§15.3 rule 4');
  });

  it('rule 5: flags missing ## Goal section', async () => {
    const findings = await validateAgentTemplate(
      'builder',
      join(fixturesRoot, 'rule5-goal-missing'),
    );
    const errors = only('error', findings);
    expect(errors.some((f) => /Goal section is missing/.test(f.message))).toBe(true);
  });

  it('rule 5: flags an empty ## Goal section', async () => {
    const findings = await validateAgentTemplate('builder', join(fixturesRoot, 'rule5-goal-empty'));
    const errors = only('error', findings);
    expect(errors.some((f) => /Goal section is empty/.test(f.message))).toBe(true);
  });

  it('rule 6: flags missing ## Definition of Done section', async () => {
    const findings = await validateAgentTemplate(
      'builder',
      join(fixturesRoot, 'rule6-dod-missing'),
    );
    const errors = only('error', findings);
    expect(errors.some((f) => /Definition of Done section is missing/.test(f.message))).toBe(true);
  });

  it('rule 6: flags ## Definition of Done with zero bullets', async () => {
    const findings = await validateAgentTemplate('builder', join(fixturesRoot, 'rule6-dod-empty'));
    const errors = only('error', findings);
    expect(errors.some((f) => /zero bullets/.test(f.message))).toBe(true);
  });

  it('rule 7: flags a Definition of Done bullet that is whitespace-only', async () => {
    const findings = await validateAgentTemplate(
      'builder',
      join(fixturesRoot, 'rule7-empty-bullet'),
    );
    const errors = only('error', findings);
    expect(errors.some((f) => /bullet is empty or whitespace only/.test(f.message))).toBe(true);
  });
});

describe('validateAgentTemplate — clean templates', () => {
  it('the fixture/clean template returns zero errors', async () => {
    const findings = await validateAgentTemplate('builder', join(fixturesRoot, 'clean'));
    expect(only('error', findings).length).toBe(0);
  });

  it("the repo's agents/builder.md returns zero errors", async () => {
    const repoRoot = resolve(here, '..', '..');
    const findings = await validateAgentTemplate('builder', repoRoot);
    const errors = only('error', findings);
    expect(errors).toEqual([]);
  });
});
