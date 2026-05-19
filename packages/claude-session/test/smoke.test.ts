import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('@mars/claude-session package', () => {
  it('exports a non-empty VERSION string', () => {
    expect(typeof VERSION).toBe('string')
    expect(VERSION.length).toBeGreaterThan(0)
  })
})
