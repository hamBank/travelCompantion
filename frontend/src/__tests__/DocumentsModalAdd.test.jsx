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
