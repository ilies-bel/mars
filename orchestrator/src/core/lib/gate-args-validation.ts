/**
 * Shared validation for verify gate args.
 *
 * Detects malformed args for package-runner commands (npm, pnpm, yarn, bunx,
 * npx): a single element that contains whitespace is almost always a quoting
 * mistake — the caller meant to pass separate tokens but accidentally passed
 * them as one string (e.g. `["run test:e2e"]` instead of `["run", "test:e2e"]`).
 *
 * When executed, `npm "run test:e2e"` passes the whole string as one argument
 * to npm, which then errors with a generic usage message rather than running
 * the intended script — the gate always fails without ever checking anything
 * meaningful.
 *
 * This module is shared by:
 *   - src/cli/commands/verify.ts     (registration-time validation)
 *   - src/cli/commands/verify-gate.ts (registration-time validation)
 *   - src/core/lib/git/verify.ts    (execution-time pre-flight validation)
 */

/**
 * Commands that act as package-runner multiplexers and require properly-split
 * args to be useful. Matches the set guarded by the bare-multiplexer check in
 * verify.ts.
 */
export const PACKAGE_RUNNER_CMDS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx'])

/**
 * Return a human-readable error message if any element of `args` contains
 * whitespace and `cmd` is a package runner, or `null` when args look valid.
 *
 * A whitespace-containing arg element is almost always a quoting mistake:
 * `["run test:e2e"]` becomes `npm "run test:e2e"` at the shell level (one
 * quoted token), which npm rejects with a generic usage error instead of
 * running the intended script.
 *
 * @example
 * detectMalformedGateArgs('npm', ['run test:e2e'])
 * // → 'gate arg "run test:e2e" contains whitespace …'
 *
 * detectMalformedGateArgs('npm', ['run', 'test:e2e'])
 * // → null
 *
 * detectMalformedGateArgs('bash', ['run test:e2e'])
 * // → null  (bash is not a package runner)
 */
export const detectMalformedGateArgs = (
  cmd: string,
  args: readonly string[],
): string | null => {
  if (!PACKAGE_RUNNER_CMDS.has(cmd)) return null
  const bad = args.find((a) => /\s/.test(a))
  if (!bad) return null
  const split = bad.trim().split(/\s+/)
  return (
    `gate arg "${bad}" contains whitespace — ` +
    `this runs \`${cmd} "${bad}"\` (one quoted token) instead of ` +
    `\`${cmd} ${split.join(' ')}\` (separate tokens). ` +
    `Split the arg: e.g. -- ${split.join(' ')} or --args ${split.join(' --args ')}`
  )
}
