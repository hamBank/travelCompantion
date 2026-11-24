import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DocumentsModal from '../components/DocumentsModal.jsx'
import * as api from '../api.js'

vi.mock('../api.js')

const photo = new File(['x'], 'passport.jpg', { type: 'image/jpeg' })

async function openAddForm() {
  render(<DocumentsModal onClose={() => {}} />)
  fireEvent.click(await screen.findByText('+ Add document'))
}

beforeEach(() => {
  vi.resetAllMocks()
  api.listDocuments.mockResolvedValue([])
  api.listDocumentFiles.mockResolvedValue([])
  api.createDocument.mockResolvedValue({ id: 7 })
  api.scanPassportFile.mockResolvedValue({})
  api.getKnownTravelers.mockResolvedValue([
    { display_name: 'Dev', user_email: 'dev@localhost', is_me: true },
    { display_name: 'Mia', user_email: null, is_me: false },
  ])
  api.uploadDocumentFile.mockResolvedValue({ id: 70, filename: 'passport.jpg', content_type: 'image/jpeg' })
})

describe('add document with a photo', () => {
  it('offers both a camera and a file picker on the new-document form', async () => {
    await openAddForm()
    expect(screen.getByTestId('doc-photo-camera').getAttribute('capture')).toBe('environment')
    expect(screen.getByTestId('doc-photo-file').getAttribute('capture')).toBeNull()
  })

  it('creates, uploads and scans a passport photo, then applies the reviewed fields', async () => {
    api.scanPassportFile.mockResolvedValue({
      holder_name: 'JANE DOE', holder_name_valid: true,
      document_number: 'X1', document_number_valid: true,
      nationality: 'AUS', nationality_valid: true,
    })
    api.updateDocument.mockResolvedValue({})
    await openAddForm()
    fireEvent.change(screen.getByTestId('doc-photo-file'), { target: { files: [photo] } })
    fireEvent.click(screen.getByText('Save document'))

    await waitFor(() => expect(api.scanPassportFile).toHaveBeenCalledWith(7, 70))
    expect(api.createDocument).toHaveBeenCalled()
    expect(api.uploadDocumentFile).toHaveBeenCalledWith(7, photo)
    fireEvent.click(await screen.findByText('Apply selected'))
    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith(
      7, expect.objectContaining({ holder_name: 'JANE DOE', document_number: 'X1' }),
    ))
  })

  it('does not scan a non-passport document', async () => {
    await openAddForm()
    fireEvent.change(screen.getByDisplayValue('Passport'), { target: { value: 'visa' } })
    fireEvent.change(screen.getByTestId('doc-photo-file'), { target: { files: [photo] } })
    fireEvent.click(screen.getByText('Save document'))
    await waitFor(() => expect(api.uploadDocumentFile).toHaveBeenCalled())
    expect(api.scanPassportFile).not.toHaveBeenCalled()
  })

  it('keeps the saved document and says so when the scan fails', async () => {
    api.scanPassportFile.mockRejectedValue(new Error('Could not locate a machine-readable zone in this image.'))
    await openAddForm()
    fireEvent.change(screen.getByTestId('doc-photo-file'), { target: { files: [photo] } })
    fireEvent.click(screen.getByText('Save document'))
    expect(await screen.findByText(/Document saved, but the photo step failed/)).toBeTruthy()
    expect(api.createDocument).toHaveBeenCalledTimes(1)
  })

  it('saves without a photo exactly as before', async () => {
    await openAddForm()
    fireEvent.click(screen.getByText('Save document'))
    await waitFor(() => expect(api.createDocument).toHaveBeenCalled())
    expect(api.uploadDocumentFile).not.toHaveBeenCalled()
  })

  it('sends null, not "", for blank dates so a photo-only document can be saved', async () => {
    // Reported: saving with no details failed with 'Input should be a valid
    // datetime or date, input is too short' because blank dates went as "".
    await openAddForm()
    fireEvent.change(screen.getByTestId('doc-photo-file'), { target: { files: [photo] } })
    fireEvent.click(screen.getByText('Save document'))
    await waitFor(() => expect(api.createDocument).toHaveBeenCalled())
    const sent = api.createDocument.mock.calls[0][0]
    expect(sent.issued_date).toBeNull()
    expect(sent.expiry_date).toBeNull()
    expect(sent.date_of_birth).toBeNull()
  })

  it('keeps dates that were entered', async () => {
    await openAddForm()
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '2030-01-02' } })
    fireEvent.click(screen.getByText('Save document'))
    await waitFor(() => expect(api.createDocument).toHaveBeenCalled())
    expect(api.createDocument.mock.calls[0][0].expiry_date).toBe('2030-01-02')
  })
})

describe('assigning a document to a traveler', () => {
  it('lists Me plus the other travelers (not the signed-in user twice)', async () => {
    await openAddForm()
    const select = screen.getByLabelText('Belongs to')
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent)
    expect(options).toEqual(['Me', 'Mia'])
  })

  it('sends the chosen traveler, and null for Me', async () => {
    await openAddForm()
    fireEvent.change(screen.getByLabelText('Belongs to'), { target: { value: 'Mia' } })
    fireEvent.click(screen.getByText('Save document'))
    await waitFor(() => expect(api.createDocument).toHaveBeenCalled())
    expect(api.createDocument.mock.calls[0][0].traveler_name).toBe('Mia')
  })

  it('sends null when left on Me', async () => {
    await openAddForm()
    fireEvent.click(screen.getByText('Save document'))
    await waitFor(() => expect(api.createDocument).toHaveBeenCalled())
    expect(api.createDocument.mock.calls[0][0].traveler_name).toBeNull()
  })

  it('shows who an existing document is for', async () => {
    api.listDocuments.mockResolvedValue([{ id: 3, doc_type: 'passport', label: 'Passport', traveler_name: 'Mia', country: '', expiry_date: null }])
    render(<DocumentsModal onClose={() => {}} />)
    expect(await screen.findByText('for Mia')).toBeTruthy()
  })
})
