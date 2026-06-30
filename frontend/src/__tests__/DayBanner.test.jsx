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
    const wx = { icon: '☀', tmin: 20.6, tmax: 30.4, desc: 'Clear', source: 'forecast' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={wx} />)
    expect(container.textContent).toContain('☀')
    expect(container.textContent).toContain('21–30°C')  // rounded, with unit
  })

  it('shows rounded wind with the wind emoji and km/h unit when present', () => {
    const wx = { icon: '☀', tmin: 20, tmax: 30, wind: 14.6, desc: 'Clear', source: 'forecast' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={wx} />)
    expect(container.textContent).toContain('💨 15km/h')
  })

  it('omits wind when not provided', () => {
    const wx = { icon: '☀', tmin: 20, tmax: 30, desc: 'Clear', source: 'forecast' }
    const { container } = render(<DayBanner dateKey="2026-07-22" weather={wx} />)
    expect(container.textContent).not.toContain('💨')
  })

  it('flags climatology data with "avg" but not live forecasts', () => {
    const climo = { icon: '⛅', tmin: 19, tmax: 32, desc: 'Partly cloudy', source: 'climatology' }
    const { container: c1 } = render(<DayBanner dateKey="2026-07-22" weather={climo} />)
    expect(c1.textContent).toContain('avg')

    const live = { icon: '☀', tmin: 15, tmax: 25, desc: 'Clear', source: 'forecast' }
    const { container: c2 } = render(<DayBanner dateKey="2026-07-02" weather={live} />)
    expect(c2.textContent).not.toContain('avg')
  })

  it('shows no weather span when weather is absent', () => {
    const { container } = render(<DayBanner dateKey="2026-07-22" />)
    expect(container.textContent).not.toContain('°')
  })
})
