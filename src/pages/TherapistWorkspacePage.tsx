import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CalendarPlus, Clock3, FileCheck2, ShieldCheck, Upload, UserRound } from 'lucide-react'
import { useAuth } from '../app/useAuth'
import { formatDateTime } from '../lib/format'
import { requireSupabase } from '../lib/supabase'
import type { Appointment, VerificationStatus } from '../lib/types'

interface TherapistRecord {
  id: string
  verification_status: VerificationStatus
  full_name: string
  professional_title: string
  biography: string
  qualifications: string[]
  specializations: string[]
  languages: string[]
  years_experience: number
  session_fee_cents: number
  session_terms: string
  session_duration_minutes: number
  consultation_format: 'online' | 'in_person' | 'both'
  photo_url: string | null
}

interface VerificationRecord {
  therapist_id: string
  legal_name: string
  registration_number: string
  issuing_jurisdiction: string
  registration_expiry: string
  registration_status: 'active' | 'pending' | 'expired' | 'not_applicable'
  qualification_details: string
  credential_paths: string[]
  status: VerificationStatus
  rejection_reason: string | null
}

const specializations = [
  'Anxiety Management',
  'Depression Support',
  'Relationship Counselling',
  'Marriage Counselling',
  'Family Therapy',
  'Grief and Loss',
  'Stress Management',
  'Trauma-Informed Therapy',
  'Personal Development',
  'Addiction Counselling',
]

export function TherapistWorkspacePage() {
  const { user } = useAuth()
  const [step, setStep] = useState<'profile' | 'verification'>('profile')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [credentialFiles, setCredentialFiles] = useState<File[]>([])
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { data: therapist, isLoading: therapistLoading, error: therapistError, refetch } = useQuery({
    queryKey: ['therapist-workspace', user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase()
        .from('therapists')
        .select('id, verification_status, full_name, professional_title, biography, qualifications, specializations, languages, years_experience, session_fee_cents, session_terms, session_duration_minutes, consultation_format, photo_url')
        .eq('id', user!.id)
        .maybeSingle()
        .returns<TherapistRecord>()
      if (queryError) throw queryError
      return data
    },
  })
  const { data: verification, error: verificationError, refetch: refetchVerification } = useQuery({
    queryKey: ['therapist-verification', user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase()
        .from('therapist_verifications')
        .select('therapist_id, legal_name, registration_number, issuing_jurisdiction, registration_expiry, registration_status, qualification_details, credential_paths, status, rejection_reason')
        .eq('therapist_id', user!.id)
        .maybeSingle()
        .returns<VerificationRecord>()
      if (queryError) throw queryError
      return data
    },
  })
  const { data: appointments = [], error: appointmentsError } = useQuery({
    queryKey: ['my-appointments', user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase().rpc('get_my_appointments')
      if (queryError) throw queryError
      return data as Appointment[]
    },
  })
  const canStartVerification = Boolean(
    therapist?.professional_title.trim()
    && therapist.biography.trim().length >= 20
    && therapist.qualifications.length > 0
    && therapist.specializations.length > 0
    && therapist.languages.length > 0,
  )
  const activeStep = canStartVerification ? step : 'profile'

  const addAvailability = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user || !start || !end) return
    setBusy(true)
    setMessage(null)
    setError(null)
    const startsAt = new Date(start)
    const endsAt = new Date(end)
    if (Number.isNaN(startsAt.valueOf()) || Number.isNaN(endsAt.valueOf()) || endsAt <= startsAt) {
      setError('Choose an end time after the start time.')
      setBusy(false)
      return
    }
    const { error: insertError } = await requireSupabase().from('therapist_availability').insert({
      therapist_id: user.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    if (insertError) setError(insertError.message)
    else {
      setMessage('Availability added.')
      setStart('')
      setEnd('')
    }
    setBusy(false)
  }

  const saveApplication = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user) return
    setBusy(true)
    setError(null)
    setMessage(null)
    const formData = new FormData(event.currentTarget)
    const title = String(formData.get('professional_title') ?? '').trim()
    const biography = String(formData.get('biography') ?? '').trim()
    const qualificationList = String(formData.get('qualifications') ?? '').split('\n').map((item) => item.trim()).filter(Boolean)
    const specializationList = formData.getAll('specializations').map(String)
    const languageList = String(formData.get('languages') ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    const years = Number(formData.get('years_experience'))
    const sessionFee = Number(formData.get('session_fee'))
    const sessionDuration = Number(formData.get('session_duration'))
    const sessionTerms = String(formData.get('session_terms') ?? '').trim()
    const consultationFormat = String(formData.get('consultation_format'))
    if (!title || biography.length < 20 || qualificationList.length === 0 || specializationList.length === 0 || !Number.isInteger(years) || years < 0 || !Number.isFinite(sessionFee) || sessionFee <= 0 || sessionTerms.length < 10 || sessionTerms.length > 5000 || ![30, 45, 50, 60, 90].includes(sessionDuration) || !['online', 'in_person', 'both'].includes(consultationFormat)) {
      setError('Add a biography of at least 20 characters, at least one qualification and specialty, and valid experience, session length, fee, and session terms.')
      setBusy(false)
      return
    }
    const client = requireSupabase()
    let photoUrl = therapist?.photo_url ?? null
    let uploadedPhotoPath: string | null = null
    if (photoFile) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(photoFile.type) || photoFile.size > 5 * 1024 * 1024) {
        setError('Profile photos must be JPG, PNG, or WebP and no larger than 5 MB.')
        setBusy(false)
        return
      }
      const photoPath = `${user.id}/${crypto.randomUUID()}-${photoFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const { error: uploadError } = await client.storage.from('therapist-avatars').upload(photoPath, photoFile, { contentType: photoFile.type, upsert: false })
      if (uploadError) {
        setError(`Unable to upload profile photo: ${uploadError.message}`)
        setBusy(false)
        return
      }
      photoUrl = client.storage.from('therapist-avatars').getPublicUrl(photoPath).data.publicUrl
      uploadedPhotoPath = photoPath
    }
    const { error: saveError } = await client.from('therapists').update({
      professional_title: title,
      biography,
      qualifications: qualificationList,
      specializations: specializationList,
      languages: languageList,
      years_experience: years,
      session_fee_cents: Math.round(sessionFee * 100),
      session_terms: sessionTerms,
      session_duration_minutes: sessionDuration,
      consultation_format: consultationFormat,
      photo_url: photoUrl,
    }).eq('id', user.id)
    if (saveError) {
      if (uploadedPhotoPath) await client.storage.from('therapist-avatars').remove([uploadedPhotoPath])
      setError(saveError.message)
    }
    else {
      await refetch()
      setPhotoFile(null)
      setStep('verification')
      setMessage('Professional profile saved. Continue with registration verification.')
    }
    setBusy(false)
  }

  const submitVerification = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user || !therapist) return
    const form = event.currentTarget
    const formData = new FormData(form)
    const legalName = String(formData.get('legal_name') ?? '').trim()
    const registrationNumber = String(formData.get('registration_number') ?? '').trim()
    const issuingJurisdiction = String(formData.get('issuing_jurisdiction') ?? '').trim()
    const registrationExpiry = String(formData.get('registration_expiry') ?? '')
    const registrationStatus = String(formData.get('registration_status') ?? 'active')
    const qualificationDetails = String(formData.get('qualification_details') ?? '').trim()
    if (!legalName || !registrationNumber || !issuingJurisdiction || !registrationExpiry || qualificationDetails.length < 10) {
      setError('Complete each required registration and qualification field.')
      return
    }
    const filesInput = formData.getAll('credentials').filter((file): file is File => file instanceof File && file.size > 0)
    const pendingFiles = filesInput
    if ((verification?.credential_paths.length ?? 0) + pendingFiles.length === 0) {
      setError('Upload at least one registration or qualification document before submitting.')
      return
    }
    for (const file of pendingFiles) {
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) {
        setError('Verification documents must be PDF, JPG, or PNG and no larger than 10 MB each.')
        return
      }
    }

    setBusy(true)
    setError(null)
    setMessage(null)
    const client = requireSupabase()
    const uploadedPaths: string[] = []
    for (const file of pendingFiles) {
      const path = `${user.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const { error: uploadError } = await client.storage.from('therapist-credentials').upload(path, file, { contentType: file.type, upsert: false })
      if (uploadError) {
        const cleanup = uploadedPaths.length ? await client.storage.from('therapist-credentials').remove(uploadedPaths) : null
        setError(cleanup?.error
          ? `Unable to upload ${file.name}: ${uploadError.message}. Some earlier files could not be cleaned up: ${cleanup.error.message}`
          : `Unable to upload ${file.name}: ${uploadError.message}`)
        setBusy(false)
        return
      }
      uploadedPaths.push(path)
    }
    const { error: saveError } = await client.from('therapist_verifications').upsert({
      therapist_id: user.id,
      legal_name: legalName,
      registration_number: registrationNumber,
      issuing_jurisdiction: issuingJurisdiction,
      registration_expiry: registrationExpiry,
      registration_status: registrationStatus,
      qualification_details: qualificationDetails,
      credential_paths: [...(verification?.credential_paths ?? []), ...uploadedPaths],
    })
    if (saveError) {
      const cleanup = uploadedPaths.length ? await client.storage.from('therapist-credentials').remove(uploadedPaths) : null
      setError(cleanup?.error
        ? `Unable to submit verification: ${saveError.message}. Uploaded files could not be cleaned up: ${cleanup.error.message}`
        : `Unable to submit verification: ${saveError.message}`)
    } else {
      setCredentialFiles([])
      form.reset()
      setMessage('Your verification information was submitted securely for administrator review.')
      await Promise.all([refetchVerification(), refetch()])
    }
    setBusy(false)
  }

  return (
    <main className="container section dashboard-page">
      <div className="dashboard-welcome">
        <div><span className="eyebrow">Professional workspace</span><h1>Your practice.</h1><p>Manage your profile, availability, and appointments.</p></div>
        <span className="dashboard-badge"><ShieldCheck size={16} /> Therapist account</span>
      </div>
      {therapistLoading ? (
        <div className="empty-state">Loading your professional profile…</div>
      ) : therapistError ? (
        <p className="notice-error" role="alert">Unable to load your therapist profile: {therapistError.message}</p>
      ) : !therapist ? (
        <p className="notice-error">Your therapist profile is missing. Please contact support so your account can be restored.</p>
      ) : (
        <>
          <div className={`verification-banner verification-${therapist.verification_status}`}>
            <ShieldCheck size={19} />
            <div><strong>Verification: {therapist.verification_status.replace('_', ' ')}</strong><span>{therapist.verification_status === 'approved' ? 'Your profile may receive bookings.' : 'Bookings are disabled until your application is approved.'}</span></div>
          </div>
          <div className="application-stepper" aria-label="Therapist registration steps">
            <button type="button" className={`step-tab ${activeStep === 'profile' ? 'step-tab-active' : ''}`} onClick={() => setStep('profile')}><span>Step 1</span> Public profile</button>
            <button type="button" className={`step-tab ${activeStep === 'verification' ? 'step-tab-active' : ''}`} disabled={!canStartVerification} onClick={() => setStep('verification')}><span>Step 2</span> Registration verification</button>
          </div>
          {!canStartVerification && <p className="muted-copy step-help">Complete and save your public profile to continue to registration verification.</p>}
          <div className="dashboard-columns">
            {activeStep === 'profile' ? (
              <section className="dashboard-panel application-form-panel">
                <div className="panel-heading"><div><span className="eyebrow">Step 1 of 2 · Public profile</span><h2>Tell clients about your practice</h2></div><UserRound size={19} /></div>
                <form className="form-stack" onSubmit={(event) => void saveApplication(event)}>
                  <label className="field"><span>Professional title</span><input name="professional_title" defaultValue={therapist.professional_title} placeholder="e.g. Counselling Psychologist" required /></label>
                  <label className="field"><span>Professional biography</span><textarea name="biography" rows={4} defaultValue={therapist.biography} minLength={20} required /></label>
                  <label className="field"><span>Qualifications</span><textarea name="qualifications" rows={3} defaultValue={therapist.qualifications.join('\n')} placeholder="List each degree or qualification on a new line" required /></label>
                  <fieldset className="specialization-fieldset">
                    <legend>Areas of support</legend>
                    <div className="specialization-options">
                      {specializations.map((specialization) => (
                        <label key={specialization}>
                          <input type="checkbox" name="specializations" value={specialization} defaultChecked={therapist.specializations.includes(specialization)} />
                          <span>{specialization}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="field"><span>Languages (comma-separated)</span><input name="languages" defaultValue={therapist.languages.join(', ')} placeholder="English, Swahili" required /></label>
                  <label className="field"><span>Profile photo (JPG, PNG, or WebP; up to 5 MB)</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)} /></label>
                  {therapist.photo_url && <p className="muted-copy">A profile photo is already uploaded. Choose a file to replace it.</p>}
                  <div className="field-row">
                    <label className="field"><span>Years of experience</span><input name="years_experience" type="number" min="0" step="1" defaultValue={therapist.years_experience} required /></label>
                    <label className="field"><span>Session fee (USD)</span><input name="session_fee" type="number" min="1" step="0.01" defaultValue={therapist.session_fee_cents / 100 || 10} required /></label>
                  </div>
                  <label className="field"><span>Session terms and conditions</span><textarea name="session_terms" rows={5} minLength={10} maxLength={5000} defaultValue={therapist.session_terms} placeholder="Explain how clients pay your session fee directly to you, your cancellation/rescheduling policy, and any preparation or participation requirements." required /><small>Clients must review and accept these terms before booking. MindBridge collects only its separate $1 booking fee.</small></label>
                  <div className="field-row">
                    <label className="field"><span>Session length</span><select name="session_duration" defaultValue={therapist.session_duration_minutes}><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="50">50 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option></select></label>
                    <label className="field"><span>Consultation format</span><select name="consultation_format" defaultValue={therapist.consultation_format}><option value="online">Online</option><option value="in_person">In person</option><option value="both">Online and in person</option></select></label>
                  </div>
                  {error && <p className="form-error" role="alert">{error}</p>}
                  {message && <p className="form-success" role="status">{message}</p>}
                  <button className="button button-primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={15} /></button>
                </form>
              </section>
            ) : (
              <section className="dashboard-panel application-form-panel">
                <div className="panel-heading"><div><span className="eyebrow">Step 2 of 2 · Private information</span><h2>Verify your professional registration</h2></div><FileCheck2 size={19} /></div>
                {verificationError && <p className="form-error" role="alert">Unable to load your verification details: {verificationError.message}. Apply the latest Supabase migration if this table is missing.</p>}
                {verification?.status === 'rejected' && verification.rejection_reason && <div className="review-reason"><strong>Admin review feedback</strong><p>{verification.rejection_reason}</p><span>Update your details or documents and resubmit for review.</span></div>}
                {verification?.status === 'approved' && <p className="form-success">Your professional registration has been verified. Update this information if your registration changes; changes require a new review.</p>}
                <form className="form-stack" onSubmit={(event) => void submitVerification(event)}>
                  <label className="field"><span>Legal name (as shown on your credentials)</span><input name="legal_name" defaultValue={verification?.legal_name || ''} autoComplete="name" required /></label>
                  <label className="field"><span>Professional licence or registration number</span><input name="registration_number" defaultValue={verification?.registration_number || ''} required /></label>
                  <label className="field"><span>Issuing authority and jurisdiction (country/region)</span><input name="issuing_jurisdiction" defaultValue={verification?.issuing_jurisdiction || ''} placeholder="e.g. National counselling board, Kenya" required /></label>
                  <div className="field-row">
                    <label className="field"><span>Registration expiry date</span><input name="registration_expiry" type="date" defaultValue={verification?.registration_expiry || ''} required /></label>
                    <label className="field"><span>Registration status</span><select name="registration_status" defaultValue={verification?.registration_status || 'active'}><option value="active">Active</option><option value="pending">Renewal pending</option><option value="expired">Expired</option><option value="not_applicable">Not applicable</option></select></label>
                  </div>
                  <label className="field"><span>Qualifications and relevant training</span><textarea name="qualification_details" rows={4} minLength={10} defaultValue={verification?.qualification_details || ''} placeholder="Institution, award, year, and relevant professional training" required /></label>
                  <label className="field"><span>Upload licence and qualification proof (PDF, JPG, or PNG; up to 10 MB per file)</span><input name="credentials" type="file" accept=".pdf,image/jpeg,image/png,application/pdf" multiple onChange={(event) => setCredentialFiles(Array.from(event.target.files ?? []))} required={!verification?.credential_paths.length} /></label>
                  {credentialFiles.length > 0 && <p className="muted-copy">Selected: {credentialFiles.map((file) => file.name).join(', ')}</p>}
                  {(verification?.credential_paths.length ?? 0) > 0 && <p className="form-success">{verification?.credential_paths.length} verification document(s) already stored privately. New uploads will be added to them.</p>}
                  <p className="privacy-note"><ShieldCheck size={15} /> These details and documents are private. Only you and authorized administrators can access them; they are not shown on your public therapist profile.</p>
                  {error && <p className="form-error" role="alert">{error}</p>}
                  {message && <p className="form-success" role="status">{message}</p>}
                  <button className="button button-primary" disabled={busy || Boolean(verificationError)} type="submit">{busy ? 'Uploading and submitting…' : verification?.status === 'approved' ? 'Update and resubmit for review' : 'Submit for verification'} <Upload size={15} /></button>
                </form>
              </section>
            )}
            <section className="dashboard-panel">
              <div className="panel-heading"><div><span className="eyebrow">Your schedule</span><h2>Offer an appointment time</h2></div><CalendarPlus size={19} /></div>
              <form className="form-stack" onSubmit={(event) => void addAvailability(event)}>
                <label className="field"><span>Starts</span><input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} required /></label>
                <label className="field"><span>Ends</span><input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} required /></label>
                {error && <p className="form-error" role="alert">{error}</p>}
                {message && <p className="form-success" role="status">{message}</p>}
                <button className="button button-primary" disabled={busy || therapist.verification_status !== 'approved'} type="submit">{busy ? 'Saving…' : 'Add availability'} <ArrowRight size={15} /></button>
                {therapist.verification_status !== 'approved' && <p className="muted-copy">Availability can be added after approval.</p>}
              </form>
            </section>
            <section className="dashboard-panel">
              <div className="panel-heading"><div><span className="eyebrow">Your calendar</span><h2>Appointments</h2></div><Clock3 size={19} /></div>
              {appointmentsError && <p className="form-error" role="alert">Unable to load appointments: {appointmentsError.message}</p>}
              {!appointmentsError && appointments.length === 0 ? <p className="muted-copy">Confirmed and pending appointments will appear here.</p> : appointments.map((item) => <article className="appointment-row" key={item.id}><span className="appointment-date"><Clock3 size={16} /></span><div><strong>{item.client_name || 'Client appointment'}</strong><span>{formatDateTime(item.starts_at)}</span></div><span className={`status-pill status-${item.status}`}>{item.status}</span></article>)}
            </section>
          </div>
        </>
      )}
    </main>
  )
}
