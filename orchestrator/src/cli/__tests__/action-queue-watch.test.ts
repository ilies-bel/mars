/**
 * Behavioural tests for the action-queue-watch data path.
 *
 * The TUI reads the daemon port from .mars/http.port (never from MARS_UI_URL
 * or a guessed default) and calls GET /view/action-queue?filter=open on the
 * daemon HTTP API. These tests verify the port-discovery and URL-construction
 * logic exposed by `resolveDaemonBaseUrl`.
 *
 * The Ink rendering layer is not exercised here (no ink-testing-library in the
 * test deps). What we test is the observable contract: given a state directory,
 * the helper produces the correct daemon base URL — or null when the port file
 * is absent or malformed. This is the core of the data-path change from the
 * old MARS_UI_URL / /api/todo scheme.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveDaemonBaseUrl } from '../action-queue-watch'

let tmpDir: string
let stateDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-aq-watch-test-'))
  stateDir = join(tmpDir, '.mars')
  mkdirSync(stateDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveDaemonBaseUrl', () => {
  it('returns null when http.port file is absent', () => {
    // No file written — the daemon is not running.
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns the correct base URL when http.port contains a valid port', () => {
    writeFileSync(join(stateDir, 'http.port'), '19999')
    expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:19999')
  })

  it('strips trailing whitespace / newlines from the port file', () => {
    writeFileSync(join(stateDir, 'http.port'), '19999\n')
    expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:19999')
  })

  it('returns null when http.port contains a non-numeric value', () => {
    writeFileSync(join(stateDir, 'http.port'), 'not-a-port')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when http.port contains zero', () => {
    writeFileSync(join(stateDir, 'http.port'), '0')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when http.port contains a negative number', () => {
    writeFileSync(join(stateDir, 'http.port'), '-1')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when http.port contains a float', () => {
    writeFileSync(join(stateDir, 'http.port'), '7777.5')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when given a completely non-existent state directory', () => {
    expect(resolveDaemonBaseUrl('/does/not/exist/.mars')).toBeNull()
  })

  it('never reads from MARS_UI_URL (env var must have no effect)', () => {
    // Even when MARS_UI_URL is set to a different host, the result is always
    // null if http.port is absent — the function ignores env vars entirely.
    const prev = process.env['MARS_UI_URL']
    process.env['MARS_UI_URL'] = 'http://127.0.0.1:7777'
    try {
      expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env['MARS_UI_URL']
      else process.env['MARS_UI_URL'] = prev
    }
  })

  it('returns daemon URL based solely on http.port, regardless of MARS_UI_URL', () => {
    writeFileSync(join(stateDir, 'http.port'), '54321')
    const prev = process.env['MARS_UI_URL']
    process.env['MARS_UI_URL'] = 'http://127.0.0.1:7777'
    try {
      // Must use the port from the file, not 7777 from MARS_UI_URL.
      expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:54321')
    } finally {
      if (prev === undefined) delete process.env['MARS_UI_URL']
      else process.env['MARS_UI_URL'] = prev
    }
  })
})
