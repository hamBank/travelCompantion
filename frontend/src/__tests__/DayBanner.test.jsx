import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DayBanner } from '../components/StopCard.jsx'

describe('DayBanner', () => {
  it('renders the formatted date', () => {
    const { container } = render(<DayBanner dateKey="2026-07-22" />)
    expect(container.textContent).toContain('Jul')
    expect(container.textContent).toContain('22')
  })

  it('appends the weather icon and rounded min–max when provided', () => {
    const wx = { icon: '☀', tmin: 20.6, tmax: 30.4, desc: 'Clear' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={wx} />)
    expect(container.textContent).toContain('☀')
    expect(container.textContent).toContain('21–30°')  // rounded
  })

  it('shows no weather span when weather is absent', () => {
    const { container } = render(<DayBanner dateKey="2026-07-22" />)
    expect(container.textContent).not.toContain('°')
  })
})
