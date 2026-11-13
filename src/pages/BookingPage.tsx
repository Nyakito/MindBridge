import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, CalendarCheck, LockKeyhole } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../app/useAuth'
import { formatDateTime, formatPrice } from '../lib/format'
import { requireSupabase } from '../lib/supabase'
import type { AvailabilitySlot, ClientAccess, Therapist } from '../lib/types'

export function BookingPage() {
  const { therapistId, slotId } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [termsAccepted, setTermsAccepted] = useState(false)
  const { data: accessData, isLoading: accessLoading, error: accessError } = useQuery({
    queryKey: ['client-access'],
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase().rpc('get_client_access')
      if (queryError) throw queryError
      return data as ClientAccess[]
    },
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data, isLoading, error: detailsError } = useQuery({
    queryKey: ['booking-details', therapistId, slotId],
    queryFn: async () => {
      const client = requireSupabase()
      const [therapistResponse, slotResponse] = await Promise.all([
        client.from('therapists').select('id, full_name, session_fee_cents, session_terms, verification_status').eq('id', therapistId!).eq('verification_status', 'approved').maybeSingle().returns<Pick<Therapist, 'id' | 'full_name' | 'session_fee_cents' | 'session_terms' | 'verification_status'>>(),
        client.from('therapist_availability').select('id, starts_at, ends_at').eq('id', slotId!).eq('therapist_id', therapistId!).eq('is_booked', false).maybeSingle().returns<AvailabilitySlot>(),
      ])
      if (therapistResponse.error) throw therapistResponse.error
      if (slotResponse.error) throw slotResponse.error
      return { therapist: therapistResponse.data, slot: slotResponse.data }
    },
  })

  const book = async () => {
    if (!user || !data?.therapist || !data.slot) return
    if (!termsAccepted) {
      setError('Review and accept the therapist’s current session terms before booking.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: bookingError } = await requireSupabase().rpc('book_appointment', {
      p_availability_id: data.slot.id,
      p_terms_accepted: termsAccepted,
      p_accepted_session_terms: data.therapist.session_terms,
      p_displayed_session_fee_cents: data.therapist.session_fee_cents,
    })
    if (bookingError) {
      setError(bookingError.message)
      setBusy(false)
      return
    }
    navigate('/dashboard', { replace: true })
  }

  if (accessLoading || isLoading) return <main className="container section"><div className="empty-state">Checking this time…</div></main>
  if (accessError) return <main className="container section"><div className="notice-error" role="alert">Unable to verify your session entitlement: {accessError.message}</div></main>
  if (detailsError) return <main className="container section"><div className="notice-error" role="alert">Unable to check this appointment: {detailsError.message}</div><Link className="back-link" to={`/therapists/${therapistId}`}><ArrowLeft size={15} /> Back to profile</Link></main>
  if (!data?.therapist || !data.slot) return <main className="container section"><div className="notice-error">This appointment time is no longer available.</div><Link className="back-link" to="/therapists"><ArrowLeft size={15} /> Return to directory</Link></main>
  if (!accessData?.[0]?.bookable_sessions_remaining) return <main className="container section"><div className="empty-state"><span className="empty-icon"><CalendarCheck size={23} /></span><h2>A booking entitlement is needed</h2><p>Each booking requires a one-time $1 MindBridge platform fee. Your therapist’s session fee is paid separately under their terms.</p><Link className="button button-primary" to="/dashboard#plans">Get a booking entitlement</Link></div></main>

  return (
    <main className="container section booking-page">
      <Link className="back-link" to={`/therapists/${therapistId}`}><ArrowLeft size={15} /> Back to profile</Link>
      <div className="booking-confirm">
        <span className="auth-symbol"><CalendarCheck size={21} /></span>
        <span className="eyebrow">One step at a time</span>
        <h1>Confirm your appointment</h1>
        <p className="booking-with">A session with <strong>{data.therapist.full_name}</strong></p>
        <div className="booking-details">
          <div><span>Date &amp; time</span><strong>{formatDateTime(data.slot.starts_at)}</strong></div>
          <div><span>Session ends</span><strong>{formatDateTime(data.slot.ends_at)}</strong></div>
          <div><span>Therapist session fee (paid separately)</span><strong>{formatPrice(data.therapist.session_fee_cents)}</strong></div>
          <div><span>MindBridge booking fee</span><strong>$1.00</strong></div>
        </div>
        <section className="booking-terms">
          <h2>Session terms and conditions</h2>
          {data.therapist.session_terms.trim()
            ? <p>{data.therapist.session_terms}</p>
            : <p className="form-error">This therapist has not published session terms yet. Booking is unavailable until they do.</p>}
          <label className="terms-acceptance">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              disabled={!data.therapist.session_terms.trim()}
            />
            <span>I have reviewed and accept these session terms and the therapist’s separately payable session fee.</span>
          </label>
        </section>
        <div className="secure-note"><LockKeyhole size={15} /> MindBridge collects the $1 booking fee only. The therapist’s session fee is paid separately under their terms. The server verifies your acceptance and the current terms and fee before confirming.</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary button-wide" type="button" disabled={busy || !termsAccepted || !data.therapist.session_terms.trim()} onClick={() => void book()}>
          {busy ? 'Confirming…' : 'Confirm appointment'}
        </button>
        <p className="booking-policy">Booking confirms the time and records the terms and session fee you accepted. Therapist session payments are not processed by MindBridge.</p>
      </div>
    </main>
  )
}
