import { GoogleLogin } from '@react-oauth/google'
import { loginWithGoogle } from '../api.js'

export default function LoginPage({ onLogin }) {
  async function handleSuccess(response) {
    try {
      const { access_token, user } = await loginWithGoogle(response.credential)
      localStorage.setItem('tc-token', access_token)
      onLogin(user)
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-8 px-6"
      style={{ background: 'var(--bg)', color: 'var(--text)' }}
    >
      <div className="text-center space-y-2">
        <div style={{ fontSize: '3rem' }}>✈</div>
        <h1 style={{ color: 'var(--accent)' }} className="text-2xl font-semibold">
          Travel Companion
        </h1>
        <p style={{ color: 'var(--text-muted)' }} className="text-sm max-w-xs">
          A private trip-planning tool for managing flight, accommodation,
          activity, and restaurant itineraries.
        </p>
      </div>

      <div
        className="px-8 py-6 flex flex-col items-center gap-4 w-full"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '0.75rem',
          maxWidth: '22rem',
        }}
      >
        <GoogleLogin
          onSuccess={handleSuccess}
          onError={() => alert('Google sign-in failed')}
          theme="filled_black"
          shape="pill"
          size="large"
        />

        <div style={{ borderTop: '1px solid var(--border)' }} className="w-full pt-4 space-y-2">
          <p style={{ color: 'var(--text-faint)' }} className="text-xs font-medium uppercase tracking-wide">
            Data we request from Google
          </p>
          <ul className="space-y-1.5">
            {[
              ['Email address', 'To verify you are an authorised user. Access is restricted to specific accounts.'],
              ['Name', 'Displayed in the app header so you can confirm which account is signed in.'],
              ['Profile picture', 'Shown as your sign-out button in the app header.'],
            ].map(([field, reason]) => (
              <li key={field} className="text-xs" style={{ color: 'var(--text-faint)' }}>
                <span style={{ color: 'var(--text-muted)' }} className="font-medium">{field}:</span>{' '}{reason}
              </li>
            ))}
          </ul>
          <p style={{ color: 'var(--text-faint)' }} className="text-xs pt-1">
            No Google account data is stored beyond your email address.
            We do not access Google Drive, Gmail, Calendar, or any other Google service.
            Data is never sold or shared with third parties.
          </p>
        </div>
      </div>

      <p style={{ color: 'var(--text-faint)' }} className="text-xs text-center">
        By signing in you agree to our{' '}
        <a href="/tos.html" style={{ color: 'var(--accent-alt)' }} className="hover:underline">
          Terms of Service
        </a>
        {' '}and{' '}
        <a href="/privacy.html" style={{ color: 'var(--accent-alt)' }} className="hover:underline">
          Privacy Policy
        </a>
      </p>
    </div>
  )
}
