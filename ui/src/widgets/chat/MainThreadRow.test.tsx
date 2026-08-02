import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MainThreadRow } from './MainThreadRow'

const render = (props: Partial<Parameters<typeof MainThreadRow>[0]> = {}): string =>
  renderToStaticMarkup(
    <MainThreadRow
      isSelected={false}
      onSelect={() => {}}
      subthreadCount={0}
      {...props}
    />,
  )

describe('MainThreadRow', () => {
  it('names itself and says what it holds', () => {
    const html = render()
    expect(html).toContain('Main thread')
    expect(html).toContain('Everything, in one place')
  })

  it('reports the subthread count it outranks', () => {
    expect(render({ subthreadCount: 3 })).toContain('3 subthreads')
  })

  it('singularises a lone subthread', () => {
    expect(render({ subthreadCount: 1 })).toContain('1 subthread')
    expect(render({ subthreadCount: 1 })).not.toContain('1 subthreads')
  })

  it('omits the count entirely when there are no subthreads', () => {
    const html = render({ subthreadCount: 0 })
    expect(html).toContain('Everything, in one place')
    expect(html).not.toContain('subthread·')
    expect(html).not.toContain('0 subthread')
  })

  it('marks itself current when selected, so it is distinguishable from the list', () => {
    expect(render({ isSelected: true })).toContain('data-selected="true"')
    expect(render({ isSelected: false })).toContain('data-selected="false"')
  })

  it('keeps alert counts out of the main-thread row', () => {
    expect(render()).not.toContain('main-thread-alert-count')
  })
})
