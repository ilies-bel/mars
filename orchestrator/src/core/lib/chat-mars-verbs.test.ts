import { describe, expect, it } from 'vitest'
import {
  SAFE_MARS_VERBS,
  DESTRUCTIVE_MARS_VERBS,
  classifyMarsVerb,
  renderMarsVoice,
} from './chat-mars-verbs'

describe('chat-mars-verbs', () => {
  describe('SAFE_MARS_VERBS', () => {
    it('includes all required safe verbs', () => {
      const required = ['list', 'show', 'diagnose', 'restart', 'unblock', 'validate', 'task-add']
      for (const verb of required) {
        expect(SAFE_MARS_VERBS).toContain(verb)
      }
    })
  })

  describe('DESTRUCTIVE_MARS_VERBS', () => {
    it('includes all required destructive verbs', () => {
      const required = ['dismiss', 'purge', 'reject', 'prune-worktree']
      for (const verb of required) {
        expect(DESTRUCTIVE_MARS_VERBS).toContain(verb)
      }
    })
  })

  describe('classifyMarsVerb', () => {
    it.each([
      'list',
      'show',
      'diagnose',
      'restart',
      'unblock',
      'validate',
      'task-add',
      'run-reflect',
      'enable-auto-reflect',
    ])('classifies safe verb %s as "safe"', (verb) => {
      expect(classifyMarsVerb(verb)).toBe('safe')
    })

    it.each(['dismiss', 'purge', 'reject', 'prune-worktree'])(
      'classifies destructive verb %s as "destructive"',
      (verb) => {
        expect(classifyMarsVerb(verb)).toBe('destructive')
      },
    )

    it('classifies an unknown verb as "unknown"', () => {
      expect(classifyMarsVerb('frobnicate')).toBe('unknown')
    })

    it('is case-sensitive: upper-cased known verb is "unknown"', () => {
      expect(classifyMarsVerb('RESTART')).toBe('unknown')
      expect(classifyMarsVerb('Purge')).toBe('unknown')
    })

    it('empty string is "unknown"', () => {
      expect(classifyMarsVerb('')).toBe('unknown')
    })
  })
})

// ── renderMarsVoice ───────────────────────────────────────────────────────────

describe('renderMarsVoice', () => {
  it('rewrites "the orchestrator did X" → "I did X"', () => {
    expect(renderMarsVoice('the orchestrator did the work')).toBe('I did the work')
  })

  it('rewrites "Mars reports Y" → "I am reporting Y"', () => {
    expect(renderMarsVoice('Mars reports everything is fine')).toBe('I am reporting everything is fine')
  })

  it('rewrites "the worktree was lost" → "I lost that worktree"', () => {
    expect(renderMarsVoice('the worktree was lost')).toBe('I lost that worktree')
  })

  it('is case-insensitive for "the orchestrator"', () => {
    expect(renderMarsVoice('The orchestrator started')).toBe('I started')
  })

  it('leaves unrelated text unchanged', () => {
    const text = 'Everything is working correctly'
    expect(renderMarsVoice(text)).toBe(text)
  })
})
