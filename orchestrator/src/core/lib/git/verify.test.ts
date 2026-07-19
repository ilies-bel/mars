/**
 * Tests for the infra-failure detection helper introduced to prevent phantom
 * test-failure counts caused by concurrent embedded-Postgres builds.
 *
 * When multiple gradle/Spring tasks run in parallel, one task's embedded-PG
 * instance can be torn down while another build is mid-suite, producing
 * "the database system is shutting down" errors in the failing steps.  These
 * are *infrastructure* failures, not code-level assertion failures. The
 * `isInfraFailureOutput` helper classifies them so the verify primitive can
 * retry once before counting them as real failures.
 *
 */
import { describe, it, expect } from 'vitest'
import { isInfraFailureOutput } from './verify'

describe('isInfraFailureOutput', () => {
  // ── positive cases (infra failures) ─────────────────────────────────────

  it('classifies FATAL postgres shutdown as infra failure', () => {
    const output =
      'FATAL: the database system is shutting down'
    expect(isInfraFailureOutput(output)).toBe(true)
  })

  it('classifies full Spring DataAccess exception as infra failure', () => {
    // This is the exact stack trace excerpt from the reported incidents.
    const output = [
      'org.springframework.dao.DataAccessResourceFailureException: jOOQ; SQL [DELETE FROM comment];',
      'FATAL: the database system is shutting down',
    ].join('\n')
    expect(isInfraFailureOutput(output)).toBe(true)
  })

  it('classifies Spring ApplicationContextException as infra failure', () => {
    const output =
      'org.springframework.context.ApplicationContextException: Failed to start bean'
    expect(isInfraFailureOutput(output)).toBe(true)
  })

  it('classifies standalone "the database system is shutting down" message as infra failure', () => {
    // Appears when postgres shuts down mid-suite and the next query hits it.
    expect(
      isInfraFailureOutput('  caused by: the database system is shutting down'),
    ).toBe(true)
  })

  it('classifies connection-refused to a port as infra failure', () => {
    expect(
      isInfraFailureOutput('Connection refused: localhost:5432'),
    ).toBe(true)
  })

  // ── negative cases (genuine failures) ────────────────────────────────────

  it('does not classify a genuine JUnit assertion failure as infra failure', () => {
    const output = [
      'org.opentest4j.AssertionFailedError: expected: <1> but was: <2>',
      '  at com.example.MyTest.testCount(MyTest.java:42)',
    ].join('\n')
    expect(isInfraFailureOutput(output)).toBe(false)
  })

  it('does not classify a TypeScript type error as infra failure', () => {
    const output =
      "src/service/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."
    expect(isInfraFailureOutput(output)).toBe(false)
  })

  it('does not classify a NullPointerException as infra failure', () => {
    const output = [
      'java.lang.NullPointerException: Cannot invoke method foo() on null',
      '  at com.example.Service.doWork(Service.java:88)',
    ].join('\n')
    expect(isInfraFailureOutput(output)).toBe(false)
  })

  it('does not classify empty output as infra failure', () => {
    // An empty failure message is ambiguous; we conservatively fall through
    // to standard failure handling rather than unconditionally retrying.
    expect(isInfraFailureOutput('')).toBe(false)
  })

  it('does not classify whitespace-only output as infra failure', () => {
    expect(isInfraFailureOutput('   \n  ')).toBe(false)
  })
})

