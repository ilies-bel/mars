import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { type AgentRole, type CompilerFinding, ROLE_CONTRACT } from './types.ts';

type Frontmatter = {
  role?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  tools?: unknown;
};

export function agentTemplatePath(repoRoot: string, role: AgentRole): string {
  return join(repoRoot, 'agents', `${role}.md`);
}

export async function validateAgentTemplate(
  role: AgentRole,
  repoRoot: string,
): Promise<CompilerFinding[]> {
  const path = agentTemplatePath(repoRoot, role);
  const findings: CompilerFinding[] = [];

  // Rule 1: file present.
  if (!existsSync(path)) {
    findings.push({
      severity: 'error',
      path,
      message: `agents/${role}.md is missing (§15.3 rule 1)`,
    });
    return findings;
  }

  const raw = await readFile(path, 'utf8');
  const parsed = matter(raw);
  const fm = parsed.data as Frontmatter;
  const body = parsed.content;

  // Rule 2: required frontmatter keys.
  for (const key of ['role', 'inputs', 'outputs', 'tools'] as const) {
    if (!(key in fm)) {
      findings.push({
        severity: 'error',
        path,
        message: `frontmatter missing required key '${key}' (§15.3 rule 2)`,
      });
    }
  }

  // Rule 3: role value matches filename.
  if (typeof fm.role === 'string' && fm.role !== role) {
    findings.push({
      severity: 'error',
      path,
      message: `frontmatter role '${fm.role}' does not match filename '${role}.md' (§15.3 rule 3)`,
    });
  }

  // Rule 4: inputs/outputs match the role contract.
  const contract = ROLE_CONTRACT[role];
  if (typeof fm.inputs === 'string' && fm.inputs !== contract.inputs) {
    findings.push({
      severity: 'error',
      path,
      message: `inputs '${fm.inputs}' does not match §15.2 contract '${contract.inputs}' for role '${role}' (§15.3 rule 4)`,
    });
  }
  if (typeof fm.outputs === 'string' && fm.outputs !== contract.outputs) {
    findings.push({
      severity: 'error',
      path,
      message: `outputs '${fm.outputs}' does not match §15.2 contract '${contract.outputs}' for role '${role}' (§15.3 rule 4)`,
    });
  }

  // Rule 5: ## Goal section present and non-empty.
  const goal = extractSection(body, 'Goal');
  if (goal === null) {
    findings.push({
      severity: 'error',
      path,
      message: '## Goal section is missing (§15.3 rule 5)',
    });
  } else if (goal.trim().length === 0) {
    findings.push({
      severity: 'error',
      path,
      message: '## Goal section is empty (§15.3 rule 5)',
    });
  }

  // Rule 6: ## Definition of Done present, has at least one bullet.
  const dod = extractSection(body, 'Definition of Done');
  if (dod === null) {
    findings.push({
      severity: 'error',
      path,
      message: '## Definition of Done section is missing (§15.3 rule 6)',
    });
  } else {
    const bullets = extractBullets(dod);
    if (bullets.length === 0) {
      findings.push({
        severity: 'error',
        path,
        message: '## Definition of Done has zero bullets (§15.3 rule 6)',
      });
    } else {
      // Rule 7: no whitespace-only bullet.
      for (const b of bullets) {
        if (b.text.trim().length === 0) {
          findings.push({
            severity: 'error',
            path,
            line: b.line,
            message: 'Definition of Done bullet is empty or whitespace only (§15.3 rule 7)',
          });
        }
      }
    }
  }

  // Rules 8-9: tool registry membership + role allowlist.
  // TODO(MVP-4 ToolRegistry): once the ToolRegistry adapter exists, replace this stub
  // with: validate that every name in fm.tools[] is registered AND in
  // (global ∪ perRole[role].allow). Today the registry does not exist;
  // returning OK preserves the function signature for callers.

  // Optional warning: missing ## Non-Goals.
  const nonGoals = extractSection(body, 'Non-Goals');
  if (nonGoals === null) {
    findings.push({
      severity: 'warn',
      path,
      message: '## Non-Goals section is missing (recommended)',
    });
  }

  return findings;
}

function extractSection(body: string, heading: string): string | null {
  const lines = body.split('\n');
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^##\\s+${escaped}\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function extractBullets(section: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const lines = section.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^\s*[-*]\s?(.*)$/);
    if (m) {
      out.push({ text: m[1] ?? '', line: i + 1 });
    }
  }
  return out;
}
