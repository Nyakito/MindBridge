import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, LockKeyhole } from 'lucide-react'
import { supabase } from '../lib/supabase'

export function AuthPage() {
  const [params] = useSearchParams()
  const signUp = params.get('mode') === 'signup' || window.location.pathname === '/sign-up'
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accountType, setAccountType] = useState<'client' | 'therapist'>('client')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      if (signUp) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name.trim(), account_type: accountType } },
        })
        if (signUpError) throw signUpError
        if (!data.session) {
          setMessage('Check your email to verify your account. Once verified, return here to sign in.')
        } else {
          navigate('/onboarding')
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
        if (signInError) throw signInError
        navigate('/dashboard')
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <Link className="back-link" to="/"><ArrowLeft size={15} /> Back to MindBridge</Link>
        <div className="auth-card">
          <span className="auth-symbol"><LockKeyhole size={20} /></span>
          <span className="eyebrow">{signUp ? 'A thoughtful first step' : 'Welcome back'}</span>
          <h1>{signUp ? 'Create your account' : 'Sign in to your space'}</h1>
          <p className="auth-description">
            {signUp ? 'Your journey begins with a secure, private account.' : 'Pick up where you left off, whenever you are ready.'}
          </p>
          <form onSubmit={(event) => void submit(event)} className="form-stack">
            {signUp && (
              <label className="field">
                <span>Full name</span>
                <input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            )}
            {signUp && (
              <fieldset className="account-type-select">
                <legend>I am joining as</legend>
                <label><input type="radio" name="accountType" value="client" checked={accountType === 'client'} onChange={() => setAccountType('client')} /><span>Seeking support</span></label>
                <label><input type="radio" name="accountType" value="therapist" checked={accountType === 'therapist'} onChange={() => setAccountType('therapist')} /><span>Therapist</span></label>
              </fieldset>
            )}
            <label className="field">
              <span>Email address</span>
              <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" autoComplete={signUp ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
              {signUp && <small>Use at least 8 characters.</small>}
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            {message && <p className="form-success" role="status">{message}</p>}
            <button className="button button-primary button-wide" disabled={busy} type="submit">
              {busy ? 'Please wait…' : signUp ? 'Create secure account' : 'Sign in'}
            </button>
          </form>
          <div className="auth-switch">
            {signUp ? 'Already have an account?' : 'New to MindBridge?'}{' '}
            <Link to={signUp ? '/sign-in' : '/sign-up'}>{signUp ? 'Sign in' : 'Create an account'}</Link>
          </div>
          <p className="auth-privacy"><LockKeyhole size={13} /> Your information is protected by secure authentication.</p>
        </div>
        <p className="auth-footnote">By continuing, you agree to review our service terms and privacy information before using therapy services.</p>
      </div>
    </main>
  )
}
