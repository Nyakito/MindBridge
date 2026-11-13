import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, Languages, UserRound } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { requireSupabase } from '../lib/supabase'
import { formatDateTime, formatPrice } from '../lib/format'
import type { AvailabilitySlot, ClientAccess, Therapist } from '../lib/types'

export function TherapistPage() {
  const { therapistId } = useParams()
  const { data: accessData, isLoading: accessLoading, error: accessError } = useQuery({
    queryKey: ['client-access'],
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase().rpc('get_client_access')
      if (queryError) throw queryError
      return data as ClientAccess[]
    },
  })
  const hasAccess = accessData?.[0]?.has_directory_access ?? false
  const { data: therapist, isLoading, error } = useQuery({
    queryKey: ['therapist', therapistId],
    enabled: Boolean(therapistId && hasAccess),
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase()
        .from('therapists')
        .select('id, full_name, professional_title, biography, qualifications, specializations, languages, years_experience, session_duration_minutes, session_fee_cents, session_terms, consultation_format, verification_status, photo_url')
        .eq('id', therapistId!)
        .eq('verification_status', 'approved')
        .maybeSingle()
        .returns<Therapist>()
      if (queryError) throw queryError
      return data
    },
  })
  const { data: slots = [], error: slotError } = useQuery({
    queryKey: ['availability', therapistId],
    enabled: Boolean(therapistId && therapist && hasAccess),
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase()
        .from('therapist_availability')
        .select('id, starts_at, ends_at')
        .eq('therapist_id', therapistId!)
        .eq('is_booked', false)
        .gte('starts_at', new Date().toISOString())
        .order('starts_at')
        .limit(12)
        .returns<AvailabilitySlot[]>()
      if (queryError) throw queryError
      return data
    },
  })

  if (accessLoading) return <main className="container section"><div className="empty-state">Checking your account access…</div></main>
  if (accessError) return <main className="container section"><div className="notice-error" role="alert">We couldn't check your account access: {accessError.message}</div></main>
  if (!hasAccess) return <main className="container section"><div className="empty-state"><span className="empty-icon"><UserRound size={23} /></span><h2>Complete your account setup</h2><p>Complete client onboarding to browse therapist profiles. Each booking requires a separate $1 MindBridge fee entitlement.</p><Link className="button button-primary" to="/dashboard">Go to your account</Link></div></main>
  if (isLoading) return <main className="container section"><div className="empty-state">Loading profile…</div></main>
  if (error || !therapist) return <main className="container section"><div className="notice-error">This profile is unavailable or has not been approved.</div><Link className="back-link" to="/therapists"><ArrowLeft size={15} /> Back to directory</Link></main>

  return (
    <main className="container section profile-page">
      <Link className="back-link" to="/therapists"><ArrowLeft size={15} /> Back to therapists</Link>
      <div className="profile-layout">
        <section className="profile-main">
          <div className="profile-heading">
            {therapist.photo_url ? <img className="profile-avatar" src={therapist.photo_url} alt="" /> : <span className="profile-avatar avatar-placeholder"><UserRound size={35} /></span>}
            <div><span className="verified-label">Verified professional</span><h1>{therapist.full_name}</h1><p>{therapist.professional_title}</p></div>
          </div>
          <div className="profile-block"><span className="eyebrow">A little about me</span><p>{therapist.biography}</p></div>
          <div className="profile-facts">
            <div><Clock3 size={17} /><span>{therapist.years_experience} years of experience</span></div>
            <div><CalendarDays size={17} /><span>{therapist.session_duration_minutes} minute sessions</span></div>
            <div><Languages size={17} /><span>{(therapist.languages ?? []).join(', ') || 'Languages not listed'}</span></div>
            <div><UserRound size={17} /><span>{therapist.consultation_format === 'both' ? 'Online or in person' : therapist.consultation_format === 'in_person' ? 'In person' : 'Online'}</span></div>
          </div>
          <div className="profile-block"><span className="eyebrow">Areas of support</span><div className="tag-list">{therapist.specializations.map((item) => <span className="tag" key={item}>{item}</span>)}</div></div>
          <div className="profile-block"><span className="eyebrow">Qualifications</span><ul className="qualification-list">{therapist.qualifications.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div className="profile-block"><span className="eyebrow">Session terms and conditions</span><p>{therapist.session_terms || 'This therapist has not published session terms yet.'}</p></div>
        </section>
        <aside className="booking-panel">
          <span className="eyebrow">Book a conversation</span>
          <h2>{formatPrice(therapist.session_fee_cents)} <small> / session</small></h2>
          <p>The session fee is payable separately to the therapist under their terms. MindBridge charges a separate $1 platform fee per booking.</p>
          {accessData?.[0]?.bookable_sessions_remaining === 0 && (
            <div className="session-entitlement-note">
              <p>Each booking requires a separate $1 MindBridge platform fee entitlement. The therapist’s session fee is payable separately.</p>
              <Link className="button button-outline button-wide" to="/dashboard#plans">View session options</Link>
            </div>
          )}
          {slotError && <p className="form-error">Unable to load availability: {slotError.message}</p>}
          <div className="slot-list">
            {slots.length === 0 ? <p className="slot-empty">No upcoming times are available yet. Check back soon.</p> : slots.map((slot) => (
              accessData?.[0]?.bookable_sessions_remaining === 0 ? (
                <div className="slot-option slot-disabled" key={slot.id}><span>{formatDateTime(slot.starts_at)}</span></div>
              ) : (
              <Link className="slot-option" to={`/book/${therapist.id}/${slot.id}`} key={slot.id}>
                <span>{formatDateTime(slot.starts_at)}</span><ArrowRight size={15} />
              </Link>
              )
            ))}
          </div>
        </aside>
      </div>
    </main>
  )
}
