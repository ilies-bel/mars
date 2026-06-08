import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_CONTRACT_SENTINEL,
  validateScopes,
  validateSupervisor,
} from '../render'
import type { SupervisorSpec } from '../detect-stack'

// ---------------------------------------------------------------------------
// validateScopes
// ---------------------------------------------------------------------------

describe('validateScopes', () => {
  it('returns empty array for null', () => {
    expect(validateScopes(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(validateScopes(undefined)).toEqual([])
  })

  it('returns empty array for empty array input', () => {
    expect(validateScopes([])).toEqual([])
  })

  it('throws when input is not an array', () => {
    expect(() => validateScopes({ path: '.', stack: 'node', verify: {} })).toThrow(
      'manifest.json `scopes` must be an array',
    )
  })

  it('returns typed entries for valid input', () => {
    const raw = [{ path: '.', stack: 'node', verify: { test: 'npm test' } }]
    expect(validateScopes(raw)).toEqual([{ path: '.', stack: 'node', verify: { test: 'npm test' } }])
  })

  it('throws when an entry is not an object', () => {
    expect(() => validateScopes(['not-an-object'])).toThrow('scopes[0] must be an object')
  })

  it('throws when path is missing', () => {
    expect(() =>
      validateScopes([{ stack: 'node', verify: { test: 'npm test' } }]),
    ).toThrow('missing required field `path`')
  })

  it('throws when path is an empty string', () => {
    expect(() =>
      validateScopes([{ path: '', stack: 'node', verify: { test: 'npm test' } }]),
    ).toThrow('missing required field `path`')
  })

  it('throws when stack is missing', () => {
    expect(() =>
      validateScopes([{ path: '.', verify: { test: 'npm test' } }]),
    ).toThrow('missing required field `stack`')
  })

  it('throws when verify is missing', () => {
    expect(() => validateScopes([{ path: '.', stack: 'node' }])).toThrow(
      'missing required field `verify`',
    )
  })

  it('throws when verify is not an object', () => {
    expect(() =>
      validateScopes([{ path: '.', stack: 'node', verify: 'npm test' }]),
    ).toThrow('missing required field `verify`')
  })

  it('throws when a verify command is an empty string', () => {
    expect(() =>
      validateScopes([{ path: '.', stack: 'node', verify: { test: '' } }]),
    ).toThrow('must be a non-empty shell command string')
  })

  it('throws when a verify command is not a string', () => {
    expect(() =>
      validateScopes([{ path: '.', stack: 'node', verify: { test: 42 } }]),
    ).toThrow('must be a non-empty shell command string')
  })
})

// ---------------------------------------------------------------------------
// validateSupervisor
// ---------------------------------------------------------------------------

const makeSpec = (overrides: Partial<SupervisorSpec> = {}): SupervisorSpec => ({
  name: 'frontend-supervisor',
  kind: 'frontend',
  persona: 'frontend developer',
  detectedFrom: ['package.json'],
  ...overrides,
})

const validContent = (name = 'frontend-supervisor'): string =>
  `---\nname: ${name}\ndescription: test\n---\n\n${WORKFLOW_CONTRACT_SENTINEL}\n\nsome body`

describe('validateSupervisor', () => {
  it('returns null for valid supervisor content', () => {
    expect(validateSupervisor(validContent(), makeSpec())).toBeNull()
  })

  it('rejects content without YAML frontmatter', () => {
    const result = validateSupervisor('no frontmatter here', makeSpec())
    expect(result).toEqual({ reason: 'missing YAML frontmatter' })
  })

  it('rejects unterminated YAML frontmatter', () => {
    const result = validateSupervisor('---\nname: frontend-supervisor\n', makeSpec())
    expect(result).toEqual({ reason: 'unterminated YAML frontmatter' })
  })

  it('rejects when frontmatter name does not match spec name', () => {
    const result = validateSupervisor(validContent('wrong-supervisor'), makeSpec())
    expect(result).toEqual({ reason: 'frontmatter name must be "frontend-supervisor"' })
  })

  it('rejects when supervisor name does not end with -supervisor', () => {
    const spec = makeSpec({ name: 'frontend' })
    const result = validateSupervisor(validContent('frontend'), spec)
    expect(result).toEqual({ reason: 'supervisor name "frontend" must end with -supervisor' })
  })

  it('rejects when workflow contract sentinel is absent', () => {
    const content = '---\nname: frontend-supervisor\ndescription: test\n---\n\nno sentinel here'
    const result = validateSupervisor(content, makeSpec())
    expect(result).toEqual({ reason: 'missing workflow contract sentinel' })
  })

  it('rejects supervisor that exceeds 500 lines', () => {
    const body = Array.from({ length: 510 }, (_, i) => `line ${i}`).join('\n')
    const content = `---\nname: frontend-supervisor\n---\n\n${WORKFLOW_CONTRACT_SENTINEL}\n${body}`
    const result = validateSupervisor(content, makeSpec())
    expect(result?.reason).toMatch(/supervisor too long/)
  })
})
