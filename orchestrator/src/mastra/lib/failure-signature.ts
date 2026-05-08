import { createHash } from 'node:crypto'

const ANSI_PATTERN =
  // CSI sequences and a few common other escape sequences.
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07|\x1B[@-Z\\-_]/g

const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '')

export const firstNonBlankLine = (text: string): string => {
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const stripped = stripAnsi(raw).trim()
    if (stripped.length > 0) return stripped
  }
  return ''
}

export const computeFailureSignature = (
  failingStep: string,
  errorOutput: string,
): string => {
  const head = firstNonBlankLine(errorOutput)
  const payload = `${failingStep}\n${head}`
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}
