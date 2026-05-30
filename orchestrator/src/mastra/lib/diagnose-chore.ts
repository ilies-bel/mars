import type { ReadSpanTrace } from './read-span-watch'

/**
 * Build the bounded prompt for a diagnose Chore — the terminal investigate-
 * only step spawned when the read-span guard trips on an ordinary coder
 * task. The Chore is forbidden from attempting the parent's work or making
 * the fix; its sole deliverable is exactly one verdict recorded via
 * `mars diagnose set <task-id> --from -`. See PRD 06e677fb.
 *
 * The prompt is fully self-contained: it carries the parent task id, the
 * parent prompt verbatim, and the read trail that preceded the abort, so
 * the agent never needs to query the queue DB to orient.
 */
const formatTrace = (trace: readonly ReadSpanTrace[]): string =>
  trace
    .map((t, i) => `  ${i + 1}. ${t.tool} ${t.target ? `→ ${t.target}` : ''}`)
    .join('\n')

export const buildDiagnoseChorePrompt = (
  parentTaskId: string,
  parentPrompt: string,
  trace: readonly ReadSpanTrace[],
): string => {
  return [
    `# Diagnose-only Chore for ${parentTaskId}`,
    '',
    `The implementor agent for ${parentTaskId} read ${trace.length} files/patterns without taking an action and was aborted by the read-span guard. Your single job is to investigate that stall and record one structured verdict against the parent task.`,
    '',
    '## Contract',
    '',
    'You MUST NOT:',
    '',
    `- attempt the parent task's work,`,
    '- make the fix yourself (no Edit, Write, Bash that modifies the repo),',
    '- spawn another diagnose Chore or any other follow-up task.',
    '',
    'You MUST end by recording exactly ONE verdict through the dedicated CLI:',
    '',
    '```',
    `mars diagnose set ${parentTaskId} --from - <<'JSON'`,
    '{',
    '  "kind": "root-cause-found",',
    '  "evidence": "<what you found and where, with file paths + line numbers when relevant>",',
    '  "involvedFiles": ["<path/to/file1>", "<path/to/file2>"],',
    '  "fixDirection": "<concrete next-step description a fix worker can act on directly>"',
    '}',
    'JSON',
    '```',
    '',
    'OR, if you cannot identify a root cause after investigating:',
    '',
    '```',
    `mars diagnose set ${parentTaskId} --from - <<'JSON'`,
    '{',
    '  "kind": "inconclusive",',
    '  "whatChecked": "<files, patterns, hypotheses you walked through>",',
    '  "whyUnscoped": "<why the original work cannot be scoped from what you read>"',
    '}',
    'JSON',
    '```',
    '',
    'Exiting WITHOUT recording a verdict is treated the same as `inconclusive`: the operator gets one actionQueue item and the original task is parked failed. There is no second attempt — this Chore is terminal.',
    '',
    `Read freely. You are exempt from the read-span guard; only a hard time/turn cap applies. Do not stage or commit anything (the parent task's branch is for the eventual fix, not for you).`,
    '',
    '## Parent prompt (verbatim)',
    '',
    parentPrompt.trim(),
    '',
    '## Read trail before abort',
    '',
    formatTrace(trace),
  ].join('\n')
}
