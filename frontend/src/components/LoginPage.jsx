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
        <p style={{ color: 'var(--text-faint)' }} className="text-sm">
          Sign in to access your itineraries
        </p>
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '0.75rem',
        }}
        className="px-8 py-6 flex flex-col items-center gap-4"
      >
        <p style={{ color: 'var(--text-muted)' }} className="text-sm">
          Continue with Google
        </p>
        <GoogleLogin
          onSuccess={handleSuccess}
          onError={() => alert('Google sign-in failed')}
          theme="filled_black"
          shape="pill"
          size="large"
        />
      </div>
    </div>
  )
}
