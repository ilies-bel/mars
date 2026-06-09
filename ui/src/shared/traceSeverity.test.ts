import { describe, expect, it } from 'bun:test'
import { traceEventRowClass } from './traceSeverity'

describe('traceEventRowClass', () => {
  it('returns distinct class strings for error, warn, and info', () => {
    const errorClass = traceEventRowClass('error')
    const warnClass = traceEventRowClass('warn')
    const infoClass = traceEventRowClass('info')

    // All three must be distinct.
    expect(errorClass).not.toBe(warnClass)
    expect(warnClass).not.toBe(infoClass)
    expect(errorClass).not.toBe(infoClass)
  })

  it('error class contains red (error) tokens', () => {
    const cls = traceEventRowClass('error')
    expect(cls).toContain('border-error')
    expect(cls).toContain('text-error')
    expect(cls).toContain('border-l-2')
  })

  it('warn class contains amber (warn) tokens', () => {
    const cls = traceEventRowClass('warn')
    expect(cls).toContain('border-warn')
    expect(cls).toContain('text-warn')
    expect(cls).toContain('border-l-2')
  })

  it('info class contains neutral (iron) tokens and does not use error/warn colors', () => {
    const cls = traceEventRowClass('info')
    expect(cls).toContain('border-iron')
    expect(cls).toContain('border-l-2')
    expect(cls).not.toContain('border-error')
    expect(cls).not.toContain('border-warn')
    expect(cls).not.toContain('text-error')
    expect(cls).not.toContain('text-warn')
  })
})
