import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import RichText from '../components/RichText.jsx'

describe('RichText', () => {
  it('renders **bold** as <strong>', () => {
    const { container } = render(<RichText>{'a **bold** word'}</RichText>)
    const strong = container.querySelector('strong')
    expect(strong).not.toBeNull()
    expect(strong.textContent).toBe('bold')
  })

  it('auto-links a bare URL', () => {
    const { getByText } = render(<RichText>{'see https://example.com now'}</RichText>)
    expect(getByText('https://example.com')).toBeInTheDocument()
  })

  it('renders [label](url) as the label, not the raw URL', () => {
    const { getByText, queryByText } = render(<RichText>{'[the site](https://example.com)'}</RichText>)
    expect(getByText('the site')).toBeInTheDocument()
    expect(queryByText('https://example.com')).toBeNull()
  })

  it('renders "- item" lines as bullets', () => {
    const { container } = render(<RichText>{'Bring:\n- passport\n- tickets'}</RichText>)
    expect(container.textContent).toContain('•')
    expect(container.textContent).toContain('passport')
    expect(container.textContent).toContain('tickets')
  })

  it('preserves line breaks', () => {
    const { container } = render(<RichText>{'line one\nline two'}</RichText>)
    expect(container.textContent).toContain('line one')
    expect(container.textContent).toContain('line two')
  })
})
