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

const IMAGE_FILE = { id: 10, document_id: 1, filename: 'passport.jpg', content_type: 'image/jpeg', size: 100, created_at: '2026-01-01T00:00:00' }
const PDF_FILE = { id: 11, document_id: 1, filename: 'doc.pdf', content_type: 'application/pdf', size: 100, created_at: '2026-01-01T00:00:00' }

const SCAN_RESULT = {
  document_number: 'L898902C3', document_number_valid: true,
  holder_name: 'ANNA MARIA ERIKSSON', nationality: 'UTO',
  date_of_birth: '1974-08-12', date_of_birth_valid: true,
  sex: 'F', issuing_country: 'UTO',
  expiry_date: '2012-04-15', expiry_date_valid: false,
  overall_valid: false,
}

async function openDocumentWithFiles(files) {
  api.listDocuments.mockResolvedValue([DOC])
  api.listDocumentFiles.mockResolvedValue(files)
  render(<UserSettings onClose={() => {}} />)
  fireEvent.click(await screen.findByText('US Passport'))
  await screen.findByText('Save document')
}

describe('Passport scan', () => {
  it('shows a "Scan passport" button only for image files', async () => {
    await openDocumentWithFiles([IMAGE_FILE, PDF_FILE])
    await screen.findByText(/passport\.jpg/)
    expect(screen.getByText('Scan passport')).toBeTruthy()
    expect(screen.getAllByText('Scan passport')).toHaveLength(1)
  })

  it('clicking Scan passport calls the API and renders one row per field with correct default check state', async () => {
    api.scanPassportFile.mockResolvedValue(SCAN_RESULT)
    await openDocumentWithFiles([IMAGE_FILE])

    fireEvent.click(await screen.findByText('Scan passport'))
    await waitFor(() => expect(api.scanPassportFile).toHaveBeenCalledWith(1, 10))

    expect(await screen.findByDisplayValue('L898902C3')).toBeTruthy()
    expect(screen.getByDisplayValue('ANNA MARIA ERIKSSON')).toBeTruthy()
    expect(screen.getByDisplayValue('2012-04-15')).toBeTruthy()

    // expiry_date_valid is false -> pre-unchecked; document_number_valid is
    // true -> pre-checked.
    const numberInput = screen.getByDisplayValue('L898902C3')
    const numberCheckbox = numberInput.closest('label').querySelector('input[type="checkbox"]')
    expect(numberCheckbox.checked).toBe(true)

    const expiryInput = screen.getByDisplayValue('2012-04-15')
    const expiryCheckbox = expiryInput.closest('label').querySelector('input[type="checkbox"]')
    expect(expiryCheckbox.checked).toBe(false)
    expect(screen.getByText(/Check digit didn't match/)).toBeTruthy()
  })

  it('applying selected fields only sends checked fields to updateDocument', async () => {
    api.scanPassportFile.mockResolvedValue(SCAN_RESULT)
    api.updateDocument.mockResolvedValue({ ...DOC })
    await openDocumentWithFiles([IMAGE_FILE])

    fireEvent.click(await screen.findByText('Scan passport'))
    await screen.findByDisplayValue('L898902C3')

    // Uncheck nationality (the first of the two "UTO" rows -- nationality,
    // then issuing_country), leave expiry_date unchecked (default), apply.
    const [nationalityInput] = screen.getAllByDisplayValue('UTO')
    fireEvent.click(nationalityInput.closest('label').querySelector('input[type="checkbox"]'))

    fireEvent.click(screen.getByText('Apply selected'))

    await waitFor(() => expect(api.updateDocument).toHaveBeenCalled())
    const patch = api.updateDocument.mock.calls[0][1]
    expect(patch.document_number).toBe('L898902C3')
    expect(patch).not.toHaveProperty('nationality')
    expect(patch).not.toHaveProperty('expiry_date')
  })

  it('editing an extracted value before applying sends the edited value', async () => {
    api.scanPassportFile.mockResolvedValue(SCAN_RESULT)
    api.updateDocument.mockResolvedValue({ ...DOC })
    await openDocumentWithFiles([IMAGE_FILE])

    fireEvent.click(await screen.findByText('Scan passport'))
    const numberInput = await screen.findByDisplayValue('L898902C3')
    fireEvent.change(numberInput, { target: { value: 'CORRECTED123' } })

    fireEvent.click(screen.getByText('Apply selected'))

    await waitFor(() => expect(api.updateDocument).toHaveBeenCalled())
    expect(api.updateDocument.mock.calls[0][1].document_number).toBe('CORRECTED123')
  })

  it('a failed scan shows the error and leaves the row usable to retry', async () => {
    api.scanPassportFile.mockRejectedValue(new Error('Passport OCR not available (tesseract-ocr not installed on this server)'))
    await openDocumentWithFiles([IMAGE_FILE])

    fireEvent.click(await screen.findByText('Scan passport'))

    expect(await screen.findByText(/tesseract-ocr not installed/)).toBeTruthy()
    expect(screen.getByText('Scan passport')).toBeTruthy()
  })
})
