import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorFirstLog } from './ErrorFirstLog'

describe('ErrorFirstLog', () => {
  it('renders plain text verbatim when no patterns match', () => {
    const html = renderToStaticMarkup(
      <ErrorFirstLog log={'just some output\nno patterns here'} />,
    )
    expect(html).toContain('just some output')
    expect(html).not.toContain('data-testid="error-first-log-error-count"')
    expect(html).not.toContain('data-testid="error-first-log-passing-toggle"')
  })

  it('shows error count badge and highlighted error block for TypeScript errors', () => {
    const log = 'src/foo.ts(1,2): error TS2345: bad arg\nFound 1 error.'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    expect(html).toContain('data-testid="error-first-log-error-count"')
    expect(html).toContain('1 error')
    expect(html).toContain('data-testid="error-first-log-errors"')
    expect(html).toContain('error TS2345')
  })

  it('pluralises the error count label for multiple errors', () => {
    const log = [
      'src/a.ts(1,1): error TS1001: bad',
      'src/b.ts(2,3): error TS2345: also bad',
    ].join('\n')
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    expect(html).toContain('2 errors')
  })

  it('shows passing count badge when passing lines are present', () => {
    const log = '✓ test one (5ms)\n✓ test two (3ms)\n× test three'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    expect(html).toContain('data-testid="error-first-log-passing-toggle"')
    expect(html).toContain('2 passing')
  })

  it('does not render the passing block by default (collapsed state)', () => {
    const log = '✓ test one\n× test two: failed'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    // The passing block is not in the initial static HTML (showPassing = false)
    expect(html).not.toContain('data-testid="error-first-log-passing"')
  })

  it('identifies vitest × failure markers as errors', () => {
    const log = '× SomeTest > failing case\n✓ SomeTest > passing case'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    expect(html).toContain('data-testid="error-first-log-errors"')
    expect(html).toContain('1 error')
    expect(html).toContain('1 passing')
  })

  it('identifies FAIL lines as errors', () => {
    const log = 'FAIL src/mytest.test.ts\n✓ some other suite'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    expect(html).toContain('data-testid="error-first-log-errors"')
  })

  it('classifies "failed" lines as errors', () => {
    const log = '3 tests, 1 failed\n✓ test a\n✓ test b'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    expect(html).toContain('1 error')
    expect(html).toContain('2 passing')
  })

  it('classifies "0 errors" as a passing line, not an error', () => {
    const log = 'Found 0 errors.'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    // "0 errors" matches PASSING_PATTERNS, not ERROR_PATTERNS
    expect(html).not.toContain('data-testid="error-first-log-error-count"')
    expect(html).toContain('1 passing')
  })

  it('forwards data-testid to the root element', () => {
    const html = renderToStaticMarkup(
      <ErrorFirstLog log={'plain output\nno patterns'} data-testid="my-log" />,
    )
    expect(html).toContain('data-testid="my-log"')
  })

  it('neutral lines are shown in a secondary block', () => {
    const log = 'src/foo.ts(1,1): error TS1234: bad\nsome neutral build output'
    const html = renderToStaticMarkup(<ErrorFirstLog log={log} />)
    expect(html).toContain('data-testid="error-first-log-neutral"')
    expect(html).toContain('some neutral build output')
  })
})
