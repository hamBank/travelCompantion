import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import UserSettings from '../components/UserSettings.jsx'
import * as api from '../api.js'

vi.mock('../api.js')
vi.mock('../vaultOfflineStore.js', () => ({
  vaultOfflineStore: {
    has: vi.fn().mockResolvedValue(false),
    get: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}))

const DOC = {
  id: 1, user_email: 'dev@local', doc_type: 'passport', label: 'US Passport',
  country: 'US', issued_date: null, expiry_date: null, notes: '',
  created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  api.getImportAddress.mockResolvedValue({ address: 'import+x@example.com' })
  api.listDocuments.mockResolvedValue([])
  api.listDocumentFiles.mockResolvedValue([])
})

describe('DocumentsSection', () => {
  it('renders the Documents heading and an empty list', async () => {
    render(<UserSettings onClose={() => {}} />)
    expect(await screen.findByText('Documents')).toBeTruthy()
    expect(screen.queryByText('US Passport')).toBeNull()
  })

  it('renders an existing document in the list', async () => {
    api.listDocuments.mockResolvedValue([DOC])
    render(<UserSettings onClose={() => {}} />)
    expect(await screen.findByText('US Passport')).toBeTruthy()
    expect(screen.getByText('US')).toBeTruthy()
  })

  it('add form submits and calls api.createDocument', async () => {
    api.createDocument.mockResolvedValue({ ...DOC, id: 2 })
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('Documents')

    fireEvent.click(screen.getByText('+ Add document'))
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. US Passport)'), { target: { value: 'My Passport' } })
    fireEvent.click(screen.getByText('Save document'))

    await waitFor(() => expect(api.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'My Passport', doc_type: 'passport' })
    ))
  })

  it('clicking a document expands edit form; saving calls api.updateDocument', async () => {
    api.listDocuments.mockResolvedValue([DOC])
    api.updateDocument.mockResolvedValue({ ...DOC, label: 'Renewed Passport' })
    render(<UserSettings onClose={() => {}} />)

    fireEvent.click(await screen.findByText('US Passport'))
    const labelInput = await screen.findByDisplayValue('US Passport')
    fireEvent.change(labelInput, { target: { value: 'Renewed Passport' } })
    fireEvent.click(screen.getByText('Save document'))

    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith(1, expect.objectContaining({ label: 'Renewed Passport' })))
  })

  it('delete is confirm-gated and calls api.deleteDocument', async () => {
    api.listDocuments.mockResolvedValueOnce([DOC]).mockResolvedValue([])
    api.deleteDocument.mockResolvedValue(null)
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('US Passport')

    const deleteButtons = screen.getAllByText('✕')
    fireEvent.click(deleteButtons[deleteButtons.length - 1])
    fireEvent.click(await screen.findByText('Confirm'))

    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith(1))
  })

  it('shows an expiry warning color for a document expiring soon', async () => {
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    api.listDocuments.mockResolvedValue([{ ...DOC, expiry_date: soon }])
    render(<UserSettings onClose={() => {}} />)

    const expiryText = await screen.findByText(/Expires/)
    expect(expiryText.style.color).toBe('var(--warning)')
  })

  it('does not warn for a document expiring far in the future', async () => {
    const farOff = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString()
    api.listDocuments.mockResolvedValue([{ ...DOC, expiry_date: farOff }])
    render(<UserSettings onClose={() => {}} />)

    const expiryText = await screen.findByText(/Expires/)
    expect(expiryText.style.color).toBe('var(--text-faint)')
  })
})
