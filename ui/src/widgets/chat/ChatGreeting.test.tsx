// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatGreeting } from './ChatGreeting'

describe('ChatGreeting', () => {
  it('renders "All quiet." when all counts are zero', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(<ChatGreeting running={0} recovering={0} needYou={0} doneToday={0} />)
    })
    expect(container.textContent).toContain('All quiet.')
    expect(container.querySelector('[data-testid="chat-greeting-board-link"]')).toBeNull()
    act(() => root.unmount())
  })

  it('shows only non-zero segments separated by " · "', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(<ChatGreeting running={3} recovering={0} needYou={2} doneToday={5} />)
    })
    expect(container.textContent).toContain('3 running · 2 need you · 5 done today')
    expect(container.textContent).not.toContain('recovering')
    act(() => root.unmount())
  })

  it('shows all four segments when all counts are non-zero', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(<ChatGreeting running={2} recovering={1} needYou={3} doneToday={4} />)
    })
    expect(container.textContent).toContain('2 running · 1 recovering · 3 need you · 4 done today')
    act(() => root.unmount())
  })

  it('shows "Open the board" link to #/progress only when needYou > 0', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(<ChatGreeting running={1} recovering={0} needYou={2} doneToday={0} />)
    })
    const link = container.querySelector('[data-testid="chat-greeting-board-link"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('#/progress')
    expect(link?.textContent).toBe('Open the board')
    act(() => root.unmount())
  })

  it('omits "Open the board" link when needYou is zero', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(<ChatGreeting running={2} recovering={1} needYou={0} doneToday={3} />)
    })
    expect(container.querySelector('[data-testid="chat-greeting-board-link"]')).toBeNull()
    expect(container.textContent).toContain('2 running · 1 recovering · 3 done today')
    act(() => root.unmount())
  })

  it('renders a single segment with no separator when only one count is non-zero', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(<ChatGreeting running={0} recovering={0} needYou={1} doneToday={0} />)
    })
    expect(container.textContent).toContain('1 need you')
    expect(container.textContent).not.toContain(' · ')
    act(() => root.unmount())
  })

  it('renders the chat-greeting test-id wrapper in every state', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(<ChatGreeting running={0} recovering={0} needYou={0} doneToday={0} />)
    })
    expect(container.querySelector('[data-testid="chat-greeting"]')).not.toBeNull()
    act(() => root.unmount())
  })
})
