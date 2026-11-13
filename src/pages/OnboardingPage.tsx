import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ShieldCheck } from 'lucide-react'
import { useAuth } from '../app/useAuth'
import { supabase } from '../lib/supabase'

const AGREEMENT_VERSION = 'mindbridge-terms-v1'

export function OnboardingPage() {
  const { user, profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const continueOnboarding = async () => {
    if (!supabase || !user || !accepted) return
    setBusy(true)
    setError(null)
    const { error: onboardingError } = await supabase.rpc('complete_onboarding', {
      p_agreement_version: AGREEMENT_VERSION,
    })
    if (onboardingError) {
      setError(onboardingError.message)
      setBusy(false)
      return
    }
    await refreshProfile()
    navigate('/dashboard')
  }

  return (
    <main className="onboarding-page">
      <div className="onboarding-card">
        <span className="auth-symbol"><ShieldCheck size={21} /></span>
        <span className="eyebrow">Before we begin</span>
        <h1>A little clarity, before you begin.</h1>
        <p>We want you to understand how your information is handled and what to expect from online support.</p>
        <div className="agreement-copy">
          <h2>{profile?.role === 'therapist' ? 'Professional confidentiality & platform participation' : 'Confidentiality & service information'}</h2>
          <p>{profile?.role === 'therapist'
            ? 'Therapists are responsible for following applicable professional, licensing, confidentiality, and record-keeping obligations. Client information may only be accessed as required to provide a booked service.'
            : "Your information is used to provide and manage your MindBridge account and appointments. Access is limited according to your role and the platform's privacy controls."}</p>
          <p>{profile?.role === 'therapist'
            ? 'Therapy confidentiality has legal and professional limits. A therapist may need to disclose information in certain circumstances, such as when required by law or when there is an immediate safety concern.'
            : 'Therapy confidentiality has legal and professional limits. A therapist may need to disclose information in certain circumstances, such as when required by law or when there is an immediate safety concern.'}</p>
          <p>MindBridge is not an emergency or crisis response service. Online sessions may have limitations, and the platform does not replace emergency, medical, or in-person care.</p>
          <p>This initial notice is a product placeholder and is not a substitute for reviewed legal terms, privacy notices, or informed consent. These materials must be finalized by qualified professionals before launch.</p>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
          <span>I have read and understand this notice and want to continue.</span>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary button-wide" type="button" disabled={!accepted || busy} onClick={() => void continueOnboarding()}>
          {busy ? 'Saving your choice…' : 'Continue'} {!busy && <Check size={16} />}
        </button>
        <p className="agreement-version">Notice version: {AGREEMENT_VERSION}</p>
      </div>
    </main>
  )
}
