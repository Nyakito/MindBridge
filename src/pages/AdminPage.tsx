import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  CreditCard,
  FileCheck2,
  MessageSquareText,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'
import { requireSupabase } from '../lib/supabase'
import { formatDateTime, formatPrice } from '../lib/format'
import { useAuth } from '../app/useAuth'
import type { Appointment, VerificationStatus } from '../lib/types'

type AdminSection = 'overview' | 'applications' | 'users' | 'appointments' | 'payments' | 'reviews' | 'support'

interface VerificationApplication {
  therapist_id: string
  legal_name: string
  registration_number: string
  issuing_jurisdiction: string
  registration_expiry: string
  registration_status: string
  qualification_details: string
  credential_paths: string[]
  status: VerificationStatus
  rejection_reason: string | null
  submitted_at: string
}

interface ReviewTherapist {
  id: string
  full_name: string
  professional_title: string
  biography: string
  specializations: string[]
  years_experience: number
  verification_status: VerificationStatus
  qualifications: string[]
  languages: string[]
  consultation_format: string
  session_duration_minutes: number
  session_fee_cents: number
  photo_url: string | null
  created_at: string
}

interface AdminProfile {
  id: string
  role: 'client' | 'therapist' | 'admin'
  full_name: string
  phone: string | null
  country: string | null
  created_at: string
}

interface AdminPayment {
  id: string
  client_id: string
  package: string
  amount_cents: number
  currency: string
  provider: string
  status: string
  mpesa_amount_kes: number | null
  mpesa_exchange_rate: number | null
  mpesa_receipt: string | null
  mpesa_phone: string | null
  mpesa_rate_updated_at: string | null
  created_at: string
}

interface AdminReview {
  id: string
  therapist_id: string
  appointment_id: string
  rating: number
  body: string
  published: boolean
  created_at: string
}

interface SupportTicket {
  id: string
  user_id: string
  category: string
  subject: string
  message: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  internal_note: string | null
  created_at: string
}

const sections: { id: AdminSection; label: string; icon: typeof ShieldCheck }[] = [
  { id: 'overview', label: 'Overview', icon: BadgeCheck },
  { id: 'applications', label: 'Therapist applications', icon: FileCheck2 },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'appointments', label: 'Appointments', icon: CalendarDays },
  { id: 'payments', label: 'Payments', icon: CreditCard },
  { id: 'reviews', label: 'Reviews', icon: MessageSquareText },
  { id: 'support', label: 'Support', icon: ShieldCheck },
]

export function AdminPage() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [section, setSection] = useState<AdminSection>('overview')
  const [search, setSearch] = useState('')
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({})
  const [ticketNotes, setTicketNotes] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [documentUrl, setDocumentUrl] = useState<string | null>(null)

  const invalidateAdmin = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin'] })
  }

  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    enabled: section === 'overview',
    queryFn: async () => {
      const client = requireSupabase()
      const [users, applications, appointments, payments, reviews, support] = await Promise.all([
        client.from('profiles').select('id', { count: 'exact', head: true }),
        client.from('therapist_verifications').select('therapist_id', { count: 'exact', head: true }).in('status', ['pending', 'under_review']),
        client.from('appointments').select('id', { count: 'exact', head: true }),
        client.from('payments').select('id', { count: 'exact', head: true }),
        client.from('reviews').select('id', { count: 'exact', head: true }).eq('published', false),
        client.from('support_tickets').select('id', { count: 'exact', head: true }).in('status', ['open', 'in_progress']),
      ])
      for (const result of [users, applications, appointments, payments, reviews, support]) {
        if (result.error) throw result.error
      }
      return {
        users: users.count ?? 0,
        applications: applications.count ?? 0,
        appointments: appointments.count ?? 0,
        payments: payments.count ?? 0,
        reviews: reviews.count ?? 0,
        support: support.count ?? 0,
      }
    },
  })

  const applications = useQuery({
    queryKey: ['admin', 'applications'],
    enabled: section === 'applications',
    queryFn: async () => {
      const client = requireSupabase()
      const [therapistResponse, verificationResponse] = await Promise.all([
        client.from('therapists')
          .select('id, full_name, professional_title, biography, specializations, years_experience, verification_status, qualifications, languages, consultation_format, session_duration_minutes, session_fee_cents, photo_url, created_at')
          .in('verification_status', ['pending', 'under_review'])
          .order('created_at')
          .returns<ReviewTherapist[]>(),
        client.from('therapist_verifications')
          .select('therapist_id, legal_name, registration_number, issuing_jurisdiction, registration_expiry, registration_status, qualification_details, credential_paths, status, rejection_reason, submitted_at')
          .in('status', ['pending', 'under_review'])
          .order('submitted_at')
          .returns<VerificationApplication[]>(),
      ])
      if (therapistResponse.error) throw therapistResponse.error
      if (verificationResponse.error) throw verificationResponse.error
      const verificationByTherapist = new Map(verificationResponse.data.map((record) => [record.therapist_id, record]))
      return therapistResponse.data.map((therapist) => ({
        therapist,
        verification: verificationByTherapist.get(therapist.id) ?? null,
      }))
    },
  })

  const users = useQuery({
    queryKey: ['admin', 'users'],
    enabled: section === 'users',
    queryFn: async () => {
      const { data, error } = await requireSupabase().from('profiles')
        .select('id, role, full_name, phone, country, created_at')
        .order('created_at', { ascending: false }).limit(500)
        .returns<AdminProfile[]>()
      if (error) throw error
      return data
    },
  })

  const appointments = useQuery({
    queryKey: ['admin', 'appointments'],
    enabled: section === 'appointments',
    queryFn: async () => {
      const { data, error } = await requireSupabase().rpc('get_my_appointments')
      if (error) throw error
      return data as Appointment[]
    },
  })

  const payments = useQuery({
    queryKey: ['admin', 'payments'],
    enabled: section === 'payments',
    queryFn: async () => {
      const { data, error } = await requireSupabase().from('payments')
        .select('id, client_id, package, amount_cents, currency, provider, status, mpesa_amount_kes, mpesa_exchange_rate, mpesa_receipt, mpesa_phone, mpesa_rate_updated_at, created_at')
        .order('created_at', { ascending: false }).limit(500)
        .returns<AdminPayment[]>()
      if (error) throw error
      return data
    },
  })

  const reviews = useQuery({
    queryKey: ['admin', 'reviews'],
    enabled: section === 'reviews',
    queryFn: async () => {
      const { data, error } = await requireSupabase().from('reviews')
        .select('id, therapist_id, appointment_id, rating, body, published, created_at')
        .order('created_at', { ascending: false }).limit(500)
        .returns<AdminReview[]>()
      if (error) throw error
      return data
    },
  })

  const support = useQuery({
    queryKey: ['admin', 'support'],
    enabled: section === 'support',
    queryFn: async () => {
      const client = requireSupabase()
      const [tickets, notes] = await Promise.all([
        client.from('support_tickets')
          .select('id, user_id, category, subject, message, status, created_at')
          .order('created_at', { ascending: false }).limit(500),
        client.from('support_ticket_notes').select('ticket_id, note'),
      ])
      if (tickets.error) throw tickets.error
      if (notes.error) throw notes.error
      const noteByTicket = new Map(notes.data.map((record) => [record.ticket_id, record.note]))
      return tickets.data.map((ticket) => ({
        ...ticket,
        internal_note: noteByTicket.get(ticket.id) ?? null,
      })) as SupportTicket[]
    },
  })

  const reviewApplication = async (therapistId: string, decision: 'approved' | 'rejected') => {
    setBusyId(therapistId)
    setErrorMessage(null)
    const { error } = await requireSupabase().rpc('review_therapist_application', {
      p_therapist_id: therapistId,
      p_decision: decision,
      p_rejection_reason: rejectionReasons[therapistId] ?? null,
    })
    if (error) setErrorMessage(error.message)
    else {
      setRejectionReasons((current) => ({ ...current, [therapistId]: '' }))
      await invalidateAdmin()
    }
    setBusyId(null)
  }

  const openCredential = async (path: string) => {
    setErrorMessage(null)
    const { data, error } = await requireSupabase().storage.from('therapist-credentials').createSignedUrl(path, 300)
    if (error) setErrorMessage(`Unable to open the private verification document: ${error.message}`)
    else if (data?.signedUrl) setDocumentUrl(data.signedUrl)
    else setErrorMessage('Supabase did not return a temporary document link.')
  }

  const moderateReview = async (id: string, published: boolean) => {
    setBusyId(id)
    setErrorMessage(null)
    const { error } = await requireSupabase().from('reviews').update({ published }).eq('id', id)
    if (error) setErrorMessage(error.message)
    else await invalidateAdmin()
    setBusyId(null)
  }

  const updateTicket = async (id: string, status: SupportTicket['status']) => {
    setBusyId(id)
    setErrorMessage(null)
    const { error } = await requireSupabase().from('support_tickets').update({ status }).eq('id', id)
    if (error) setErrorMessage(error.message)
    else await invalidateAdmin()
    setBusyId(null)
  }

  const saveTicketNote = async (ticket: SupportTicket) => {
    setBusyId(ticket.id)
    setErrorMessage(null)
    if (!user) {
      setErrorMessage('Your administrator session is no longer available. Sign in again.')
      setBusyId(null)
      return
    }
    const note = (ticketNotes[ticket.id] ?? ticket.internal_note ?? '').trim()
    if (!note) {
      setErrorMessage('Add an internal note before saving.')
      setBusyId(null)
      return
    }
    const { error } = await requireSupabase().from('support_ticket_notes')
      .upsert({ ticket_id: ticket.id, admin_id: user.id, note })
    if (error) setErrorMessage(error.message)
    else await invalidateAdmin()
    setBusyId(null)
  }

  const matchesSearch = (value: string) => value.toLowerCase().includes(search.toLowerCase())

  return (
    <main className="container section dashboard-page admin-page">
      <div className="dashboard-welcome">
        <div><span className="eyebrow">MindBridge operations</span><h1>Administration</h1><p>Review applications and keep essential platform activity in one place.</p></div>
        <span className="dashboard-badge"><ShieldCheck size={16} /> Restricted access</span>
      </div>
      <nav className="admin-nav" aria-label="Administration sections">
        {sections.map(({ id, label, icon: Icon }) => (
          <button type="button" className={`admin-nav-item ${section === id ? 'admin-nav-active' : ''}`} onClick={() => { setSection(id); setSearch(''); setErrorMessage(null) }} key={id}>
            <Icon size={16} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <label className="admin-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${section === 'overview' ? 'administration' : section}…`} /></label>
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}

      {section === 'overview' && (
        <section>
          <div className="admin-section-heading"><div><span className="eyebrow">At a glance</span><h2>Platform overview</h2></div><span className="muted-copy">Counts refresh when you open this page.</span></div>
          {overview.isLoading && <p className="muted-copy">Loading platform activity…</p>}
          {overview.error && <p className="form-error" role="alert">Unable to load platform summary: {overview.error.message}</p>}
          {overview.data && (
            <div className="admin-stat-grid">
              <StatCard label="Registered users" count={overview.data.users} icon={<Users size={18} />} onClick={() => setSection('users')} />
              <StatCard label="Applications to review" count={overview.data.applications} icon={<FileCheck2 size={18} />} onClick={() => setSection('applications')} />
              <StatCard label="Appointments" count={overview.data.appointments} icon={<CalendarDays size={18} />} onClick={() => setSection('appointments')} />
              <StatCard label="Payment records" count={overview.data.payments} icon={<CreditCard size={18} />} onClick={() => setSection('payments')} />
              <StatCard label="Unpublished reviews" count={overview.data.reviews} icon={<MessageSquareText size={18} />} onClick={() => setSection('reviews')} />
              <StatCard label="Open support tickets" count={overview.data.support} icon={<ShieldCheck size={18} />} onClick={() => setSection('support')} />
            </div>
          )}
          <div className="admin-help"><strong>Suggested review order</strong><p>Verify professional credentials before approving a therapist. Then review open support cases, unpublished reviews, and payment records that need attention.</p></div>
        </section>
      )}

      {section === 'applications' && (
        <section className="dashboard-panel admin-panel">
          <div className="panel-heading"><div><span className="eyebrow">Therapist verification</span><h2>Applications awaiting review</h2></div><span className="count-badge">{applications.data?.length ?? 0}</span></div>
          {applications.isLoading && <p className="muted-copy">Loading applications…</p>}
          {applications.error && <p className="form-error" role="alert">Unable to load applications: {applications.error.message}. Apply the latest Supabase migration.</p>}
          {!applications.isLoading && !applications.error && !applications.data?.length && <EmptyMessage title="No applications to review" detail="New applications will appear here after therapists submit their verification details." />}
          <div className="application-list">
            {applications.data?.filter(({ therapist }) => matchesSearch(`${therapist.full_name} ${therapist.professional_title} ${therapist.id}`)).map(({ therapist, verification }) => (
              <article className="application-review-card" key={therapist.id}>
                <div className="application-review-heading">
                  {therapist.photo_url ? <img className="therapist-avatar" src={therapist.photo_url} alt="" /> : <span className="therapist-avatar avatar-placeholder"><Users size={22} /></span>}
                  <div><span className="status-pill status-pending">{therapist.verification_status.replace('_', ' ')}</span><h3>{therapist.full_name}</h3><span>{therapist.professional_title}</span></div>
                  <small>Submitted {verification ? formatDateTime(verification.submitted_at) : 'profile incomplete'}</small>
                </div>
                {!verification ? (
                  <p className="form-error">Verification information is missing. Do not approve this therapist until they submit their registration and credential documents.</p>
                ) : (
                  <>
                    <div className="verification-detail-grid">
                      <Detail label="Legal name" value={verification.legal_name} />
                      <Detail label="Registration number" value={verification.registration_number} />
                      <Detail label="Issuing jurisdiction" value={verification.issuing_jurisdiction} />
                      <Detail label="Registration expiry" value={verification.registration_expiry} />
                      <Detail label="Registration status" value={verification.registration_status} />
                      <Detail label="Experience" value={`${therapist.years_experience} years`} />
                    </div>
                    <div className="application-review-block"><strong>Qualifications and training</strong><p>{verification.qualification_details}</p></div>
                    <div className="application-review-block"><strong>Public profile summary</strong><p>{therapist.biography}</p><div className="tag-list">{therapist.specializations.map((item) => <span className="tag" key={item}>{item}</span>)}</div><p>{therapist.qualifications.join(' · ')} · {therapist.languages.join(', ')} · {therapist.consultation_format.replace('_', ' ')} · {therapist.session_duration_minutes} minutes · {formatPrice(therapist.session_fee_cents)}</p></div>
                    <div className="credential-links"><strong>Private supporting documents</strong>{verification.credential_paths.length === 0 ? <p className="form-error">No documents uploaded.</p> : verification.credential_paths.map((path) => <button className="text-link" type="button" key={path} onClick={() => void openCredential(path)}><FileCheck2 size={14} /> Open {path.split('/').at(-1)} <ArrowRight size={14} /></button>)}</div>
                  </>
                )}
                <div className="application-review-actions">
                  <label className="field"><span>Reason (required for rejection)</span><textarea rows={2} minLength={8} value={rejectionReasons[therapist.id] ?? ''} onChange={(event) => setRejectionReasons((current) => ({ ...current, [therapist.id]: event.target.value }))} placeholder="Explain what needs attention so the therapist can respond." /></label>
                  <div className="application-actions">
                    <button className="button button-primary button-small" disabled={busyId === therapist.id || !verification} onClick={() => void reviewApplication(therapist.id, 'approved')} type="button"><Check size={15} /> Approve</button>
                    <button className="button button-outline button-small" disabled={busyId === therapist.id || !verification || (rejectionReasons[therapist.id] ?? '').trim().length < 8} onClick={() => void reviewApplication(therapist.id, 'rejected')} type="button"><X size={15} /> Reject</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {section === 'users' && (
        <AdminListSection title="Users" eyebrow="Accounts" loading={users.isLoading} error={users.error?.message}>
          <div className="admin-table">
            {users.data?.filter((item) => matchesSearch(`${item.full_name} ${item.role} ${item.id}`)).map((item) => <div className="admin-table-row" key={item.id}><div><strong>{item.full_name || 'Name not provided'}</strong><span>{item.id}</span></div><span className={`status-pill status-${item.role === 'admin' ? 'approved' : 'pending'}`}>{item.role}</span><span>{item.country || 'Country not provided'}</span><span>{formatDateTime(item.created_at)}</span></div>)}
            {users.data?.length === 0 && <EmptyMessage title="No users found" detail="Registered accounts will appear here." />}
          </div>
        </AdminListSection>
      )}

      {section === 'appointments' && (
        <AdminListSection title="Appointments" eyebrow="Scheduling" loading={appointments.isLoading} error={appointments.error?.message}>
          <div className="admin-table">
            {appointments.data?.filter((item) => matchesSearch(`${item.client_name} ${item.therapist_name} ${item.status}`)).map((item) => <div className="admin-table-row" key={item.id}><div><strong>{item.client_name || 'Client'}</strong><span>with {item.therapist_name || 'Therapist'}</span></div><span className={`status-pill status-${item.status}`}>{item.status}</span><span>{formatDateTime(item.starts_at)}</span><span>Ends {formatDateTime(item.ends_at)}</span></div>)}
            {appointments.data?.length === 0 && <EmptyMessage title="No appointments yet" detail="Booked sessions will appear here." />}
          </div>
        </AdminListSection>
      )}

      {section === 'payments' && (
        <AdminListSection title="Payments" eyebrow="Transactions" loading={payments.isLoading} error={payments.error?.message}>
          <div className="admin-table">
            {payments.data?.filter((item) => matchesSearch(`${item.package} ${item.provider} ${item.status} ${item.client_id} ${item.mpesa_receipt ?? ''} ${item.mpesa_phone ?? ''}`)).map((item) => <div className="admin-table-row" key={item.id}><div><strong>{item.package.replace('_', ' ')} · {item.provider.toUpperCase()}</strong><span>Client {item.client_id}</span>{item.mpesa_phone && <span>M-Pesa {item.mpesa_phone}</span>}{item.mpesa_receipt && <span>Receipt {item.mpesa_receipt}</span>}</div><div><strong>{formatPrice(item.amount_cents)}</strong>{item.mpesa_amount_kes && <span>Quoted KES {item.mpesa_amount_kes.toLocaleString('en-KE')}</span>}{item.mpesa_exchange_rate && <span>Rate {item.mpesa_exchange_rate} KES/USD</span>}{item.mpesa_rate_updated_at && <span>Rate updated {formatDateTime(item.mpesa_rate_updated_at)}</span>}</div><span className={`status-pill status-${item.status === 'successful' ? 'approved' : 'pending'}`}>{item.status.replace('_', ' ')}</span><span>{formatDateTime(item.created_at)}</span></div>)}
            {payments.data?.length === 0 && <EmptyMessage title="No payments recorded" detail="Payment transactions will appear here." />}
          </div>
        </AdminListSection>
      )}

      {section === 'reviews' && (
        <AdminListSection title="Review moderation" eyebrow="Client feedback" loading={reviews.isLoading} error={reviews.error?.message}>
          <div className="application-list">
            {reviews.data?.filter((item) => matchesSearch(`${item.body} ${item.therapist_id} ${item.rating}`)).map((review) => <article className="application-review-card" key={review.id}><div className="application-review-heading"><div><span className={`status-pill ${review.published ? 'status-approved' : 'status-pending'}`}>{review.published ? 'Published' : 'Needs review'}</span><h3>{review.rating} / 5 · Therapist {review.therapist_id}</h3><span>{formatDateTime(review.created_at)}</span></div></div><p className="review-body">{review.body}</p><div className="application-actions"><button className="button button-primary button-small" disabled={busyId === review.id || review.published} onClick={() => void moderateReview(review.id, true)} type="button"><Check size={15} /> Publish</button><button className="button button-outline button-small" disabled={busyId === review.id || !review.published} onClick={() => void moderateReview(review.id, false)} type="button"><X size={15} /> Hide</button></div></article>)}
            {reviews.data?.length === 0 && <EmptyMessage title="No reviews to moderate" detail="Reviews submitted after completed sessions will appear here." />}
          </div>
        </AdminListSection>
      )}

      {section === 'support' && (
        <AdminListSection title="Support queue" eyebrow="Client and therapist support" loading={support.isLoading} error={support.error?.message}>
          <div className="application-list">
            {support.data?.filter((item) => matchesSearch(`${item.subject} ${item.category} ${item.status} ${item.user_id}`)).map((ticket) => <article className="application-review-card" key={ticket.id}><div className="application-review-heading"><div><span className={`status-pill ${ticket.status === 'resolved' || ticket.status === 'closed' ? 'status-approved' : 'status-pending'}`}>{ticket.status.replace('_', ' ')}</span><h3>{ticket.subject}</h3><span>{ticket.category.replace('_', ' ')} · {formatDateTime(ticket.created_at)} · User {ticket.user_id}</span></div></div><p className="review-body">{ticket.message}</p><label className="field"><span>Internal note (visible to administrators only)</span><textarea rows={2} value={ticketNotes[ticket.id] ?? ticket.internal_note ?? ''} onChange={(event) => setTicketNotes((current) => ({ ...current, [ticket.id]: event.target.value }))} placeholder="Private note for the support team" /></label><div className="support-admin-actions"><label className="field"><span>Update status</span><select value={ticket.status} onChange={(event) => void updateTicket(ticket.id, event.target.value as SupportTicket['status'])} disabled={busyId === ticket.id}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></label><button className="button button-outline button-small" disabled={busyId === ticket.id} onClick={() => void saveTicketNote(ticket)} type="button">Save internal note</button></div></article>)}
            {support.data?.length === 0 && <EmptyMessage title="Support queue is clear" detail="Support requests will appear here when the ticket form is enabled for users." />}
          </div>
        </AdminListSection>
      )}
      {documentUrl && <div className="modal-backdrop" role="presentation" onClick={() => setDocumentUrl(null)}><section className="document-modal" role="dialog" aria-modal="true" aria-label="Private credential document" onClick={(event) => event.stopPropagation()}><button type="button" className="button button-outline button-small" onClick={() => setDocumentUrl(null)}>Close</button><iframe title="Private therapist verification document" src={documentUrl} /></section></div>}
    </main>
  )
}

function StatCard({ label, count, icon, onClick }: { label: string; count: number; icon: React.ReactNode; onClick: () => void }) {
  return <button type="button" className="admin-stat-card" onClick={onClick}><span>{icon}</span><strong>{count}</strong><span>{label}</span><ArrowRight size={14} /></button>
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value || 'Not provided'}</strong></div>
}

function EmptyMessage({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-icon"><ShieldCheck size={21} /></span><h2>{title}</h2><p>{detail}</p></div>
}

function AdminListSection({ title, eyebrow, loading, error, children }: { title: string; eyebrow: string; loading: boolean; error?: string; children: React.ReactNode }) {
  return <section className="dashboard-panel admin-panel"><div className="panel-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div></div>{loading && <p className="muted-copy">Loading…</p>}{error && <p className="form-error" role="alert">{error}</p>}{children}</section>
}
