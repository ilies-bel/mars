import { describe, expect, it } from 'vitest'
import {
  SAFE_MARS_VERBS,
  DESTRUCTIVE_MARS_VERBS,
  classifyMarsVerb,
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
      'attach',
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
