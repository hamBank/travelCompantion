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
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '0.75rem',
        }}
        className="px-8 py-6 flex flex-col items-center gap-4 max-w-xs w-full"
      >
        <p style={{ color: 'var(--text-muted)' }} className="text-sm text-center">
          Sign in with your Google account to access your itineraries.
          Your email address is used only to verify you are an authorised user.
        </p>
        <GoogleLogin
          onSuccess={handleSuccess}
          onError={() => alert('Google sign-in failed')}
          theme="filled_black"
          shape="pill"
          size="large"
        />
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
