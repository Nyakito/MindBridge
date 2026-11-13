import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ArrowRight, CalendarDays, Clock3, CreditCard, ShieldCheck } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../app/useAuth'
import { formatDateTime } from '../lib/format'
import { requireSupabase, supabase } from '../lib/supabase'
import type { Appointment, ClientAccess } from '../lib/types'

interface MpesaQuote {
  paymentId: string
  phone: string
  amountKes: number
  exchangeRate: number
  rateUpdatedAt: string
  quoteExpiresAt: string
}

export function DashboardPage() {
  const { user, profile } = useAuth()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const showHistory = searchParams.get('section') === 'history'
  const [quote, setQuote] = useState<MpesaQuote | null>(null)
  const [paymentBusy, setPaymentBusy] = useState<'quote' | 'initiate' | 'status' | null>(null)
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'successful' | 'failed' | null>(null)
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [ticketBusy, setTicketBusy] = useState(false)
  const [ticketMessage, setTicketMessage] = useState<string | null>(null)
  const [ticketError, setTicketError] = useState<string | null>(null)
  const { data: access, error: accessError } = useQuery({
    queryKey: ['client-access', user?.id],
    enabled: Boolean(user && profile?.role === 'client'),
    queryFn: async () => {
      const { data, error } = await requireSupabase().rpc('get_client_access')
      if (error) throw error
      return (data as ClientAccess[])[0] ?? null
    },
  })
  const { data: appointments = [], isLoading, error } = useQuery({
    queryKey: ['my-appointments', user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase().rpc('get_my_appointments')
      if (queryError) throw queryError
      return data as Appointment[]
    },
  })

  const visibleAppointments = showHistory
    ? appointments.filter((appointment) => appointment.status === 'completed' || appointment.status === 'cancelled')
    : appointments.filter((appointment) => appointment.status === 'confirmed' || appointment.status === 'pending')
  const readFunctionError = async (error: { message: string; context?: unknown }) => {
    if (error.context instanceof Response) {
      try {
        const responseBody: unknown = await error.context.clone().json()
        if (responseBody && typeof responseBody === 'object' && 'error' in responseBody
            && typeof responseBody.error === 'string') return responseBody.error
      } catch {
        return error.message
      }
    }
    return error.message
  }
  const requestQuote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    const formData = new FormData(event.currentTarget)
    setPaymentBusy('quote')
    setPaymentError(null)
    setPaymentMessage(null)
    const { data, error: quoteError } = await supabase.functions.invoke<MpesaQuote>('create-mpesa-quote', {
      body: { phone: String(formData.get('mpesa-phone') ?? '') },
    })
    if (quoteError) setPaymentError(await readFunctionError(quoteError))
    else if (!data?.paymentId || !data.amountKes) setPaymentError('The exchange quote could not be created.')
    else {
      setQuote(data)
      setPaymentStatus(null)
    }
    setPaymentBusy(null)
  }
  const confirmMpesaPayment = async () => {
    if (!supabase || !quote) return
    setPaymentBusy('initiate')
    setPaymentError(null)
    setPaymentMessage(null)
    const { data, error: initiateError } = await supabase.functions.invoke<{ status: string; message: string }>('initiate-mpesa-stk', {
      body: { paymentId: quote.paymentId },
    })
    if (initiateError) {
      setPaymentError(await readFunctionError(initiateError))
      setPaymentStatus('pending')
      setPaymentMessage('The request result may be delayed. Check status before trying again.')
    }
    else {
      setPaymentStatus('pending')
      setPaymentMessage(data?.message ?? 'STK Push requested. Complete the prompt on your phone, then check status here.')
    }
    setPaymentBusy(null)
  }
  const checkMpesaStatus = async () => {
    if (!supabase || !quote) return
    setPaymentBusy('status')
    setPaymentError(null)
    const { data, error: statusError } = await supabase.functions.invoke<{
      status: 'pending' | 'successful' | 'failed'
      message?: string
    }>('mpesa-payment-status', { body: { paymentId: quote.paymentId } })
    if (statusError) setPaymentError(await readFunctionError(statusError))
    else if (data) {
      setPaymentStatus(data.status)
      setPaymentMessage(data.message ?? (data.status === 'successful'
        ? 'Payment confirmed. Your booking entitlement is active.'
        : data.status === 'failed'
          ? 'The payment was cancelled. You can request a new quote.'
          : 'Payment is still pending. Complete the STK prompt or check again shortly.'))
      if (data.status === 'successful') {
        await queryClient.invalidateQueries({ queryKey: ['client-access', user?.id] })
      }
    }
    setPaymentBusy(null)
  }
  const createSupportTicket = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user || !supabase) return
    const form = event.currentTarget
    const formData = new FormData(form)
    setTicketBusy(true)
    setTicketMessage(null)
    setTicketError(null)
    const { error: insertError } = await supabase.from('support_tickets').insert({
      user_id: user.id,
      category: String(formData.get('category')),
      subject: String(formData.get('subject')).trim(),
      message: String(formData.get('message')).trim(),
    })
    if (insertError) setTicketError(insertError.message)
    else {
      form.reset()
      setTicketMessage('Your support request was sent. The MindBridge team will review it.')
    }
    setTicketBusy(false)
  }

  return (
    <main className="container section dashboard-page">
      <div className="dashboard-welcome">
        <div><span className="eyebrow">Your private space</span><h1>Welcome, {profile?.full_name?.split(' ')[0] || 'there'}.</h1><p>A place to manage your support, at your own pace.</p></div>
        <span className="dashboard-badge"><ShieldCheck size={16} /> Private account</span>
      </div>
      <section className="access-banner">
        <div className="access-icon"><CalendarDays size={20} /></div>
        <div className="access-copy">
          <strong>{access?.bookable_sessions_remaining ? 'Your booking entitlement is ready.' : 'Your next step is yours to choose.'}</strong>
          <span>
            {access?.bookable_sessions_remaining
              ? 'Explore therapists and choose a time. Their session fee is paid separately.'
              : 'Explore therapist profiles for free. A $1 MindBridge booking fee entitlement is required for each booking; the therapist session fee is paid separately.'}
          </span>
        </div>
        <Link className="button button-primary button-small" to="/therapists">
          Find a therapist <ArrowRight size={15} />
        </Link>
      </section>
      {accessError && <p className="notice-error" role="alert">Unable to check your access: {accessError.message}</p>}
      <div className="dashboard-columns">
        <section className="dashboard-panel">
          <div className="panel-heading"><div><span className="eyebrow">Your calendar</span><h2>{showHistory ? 'Appointment history' : 'Upcoming appointments'}</h2></div><CalendarDays size={19} /></div>
          {isLoading && <p className="muted-copy">Loading appointments…</p>}
          {error && <p className="form-error">Unable to load appointments: {error.message}</p>}
          {!isLoading && !error && visibleAppointments.length === 0 && <p className="muted-copy">{showHistory ? 'Completed or cancelled appointments will appear here.' : 'There are no upcoming appointments yet. When you are ready, you can find a therapist who feels right for you.'}</p>}
          <div className="appointment-list">
            {visibleAppointments.map((appointment) => (
              <article className="appointment-row" key={appointment.id}>
                <span className="appointment-date"><CalendarDays size={17} /></span>
                <div><strong>{appointment.therapist_name || 'Therapy session'}</strong><span>{formatDateTime(appointment.starts_at)}</span></div>
                <span className={`status-pill status-${appointment.status}`}>{appointment.status}</span>
              </article>
            ))}
          </div>
          <Link to={showHistory ? '/dashboard' : '/dashboard?section=history'} className="text-link">{showHistory ? 'View upcoming appointments' : 'View appointment history'} <ArrowRight size={14} /></Link>
        </section>
        <section className="dashboard-panel">
          <div className="panel-heading"><div><span className="eyebrow">A helpful reminder</span><h2>Your wellbeing matters</h2></div><Clock3 size={19} /></div>
          <p className="muted-copy">Therapy can be a meaningful source of support, but MindBridge is not an emergency service. If you need immediate help, contact emergency or crisis support where you are.</p>
          <Link to="/#approach" className="text-link">Learn about our approach <ArrowRight size={14} /></Link>
        </section>
        <section className="dashboard-panel">
          <div className="panel-heading"><div><span className="eyebrow">We can help</span><h2>Contact support</h2></div><ShieldCheck size={19} /></div>
          <p className="muted-copy">For account, payment, booking, or technical issues. Do not include sensitive clinical notes or emergency information.</p>
          <form className="form-stack support-form" onSubmit={(event) => void createSupportTicket(event)}>
            <label className="field"><span>Topic</span><select name="category" defaultValue="account"><option value="booking">Booking</option><option value="payment">Payment</option><option value="therapist_concern">Therapist concern</option><option value="account">Account</option><option value="technical">Technical issue</option><option value="other">Other</option></select></label>
            <label className="field"><span>Subject</span><input name="subject" minLength={4} maxLength={160} required /></label>
            <label className="field"><span>How can we help?</span><textarea name="message" rows={3} minLength={10} maxLength={4000} required /></label>
            {ticketError && <p className="form-error" role="alert">Unable to submit support request: {ticketError}</p>}
            {ticketMessage && <p className="form-success" role="status">{ticketMessage}</p>}
            <button type="submit" className="button button-outline" disabled={ticketBusy}>{ticketBusy ? 'Sending…' : 'Send support request'}</button>
          </form>
        </section>
      </div>
      <section className="plans-section" id="plans">
        <div className="section-heading">
          <div><span className="eyebrow"><CreditCard size={14} /> Pay with M-Pesa</span><h2>Pay the booking fee.</h2></div>
          <p>The USD $1 MindBridge booking fee is converted to Kenyan shillings using the latest published rate. The therapist’s session fee is separate and paid directly under their terms.</p>
        </div>
        <div className="plan-grid plan-grid-single">
          <article className="plan-card">
            <span className="plan-name">MindBridge booking fee</span>
            <strong className="plan-price">$1 USD</strong>
            <span className="plan-detail">One booking entitlement</span>
            <p>Enter your Kenyan Safaricom number to get an exchange-rate quote. You will review the exact KES charge before an STK Push is requested.</p>
            <form className="form-stack" onSubmit={(event) => void requestQuote(event)}>
              <label className="field">
                <span>Safaricom phone number</span>
                <input name="mpesa-phone" type="tel" autoComplete="tel" placeholder="0712345678 or +254712345678" required />
              </label>
              <button type="submit" className="button button-outline button-wide" disabled={paymentBusy !== null}>
                {paymentBusy === 'quote' ? 'Getting latest rate…' : 'Get exact KES quote'}
              </button>
            </form>
            {quote && (
              <div className="mpesa-quote" aria-live="polite">
                <strong>Confirm your payment</strong>
                <p>MindBridge booking fee: USD $1.00</p>
                <p className="mpesa-amount">Charge now: KES {quote.amountKes.toLocaleString('en-KE')}</p>
                <p>Rate: 1 USD = {quote.exchangeRate.toFixed(8)} KES, published {new Date(quote.rateUpdatedAt).toLocaleString()}</p>
                <p>Safaricom number: +{quote.phone}</p>
                <p>Quote valid until {new Date(quote.quoteExpiresAt).toLocaleTimeString()}.</p>
                {paymentStatus !== 'successful' && paymentStatus !== 'failed' && (
                  <button
                    type="button"
                    className="button button-primary button-wide"
                    disabled={paymentBusy !== null || paymentStatus === 'pending'}
                    onClick={() => void confirmMpesaPayment()}
                  >
                    {paymentBusy === 'initiate' ? 'Requesting STK Push…' : 'Confirm and send STK Push'}
                  </button>
                )}
                {paymentStatus === 'pending' && (
                  <button type="button" className="button button-outline button-wide" disabled={paymentBusy !== null} onClick={() => void checkMpesaStatus()}>
                    {paymentBusy === 'status' ? 'Checking with Daraja…' : 'Check payment status'}
                  </button>
                )}
                {paymentMessage && <p className={paymentStatus === 'successful' ? 'form-success' : 'muted-copy'} role="status">{paymentMessage}</p>}
              </div>
            )}
          </article>
        </div>
        {paymentError && <p className="form-error" role="alert">M-Pesa payment: {paymentError}</p>}
        <p className="payment-note">Your entitlement activates only after Daraja status is checked server-side and the payment details are matched. MindBridge does not collect the therapist’s session fee.</p>
      </section>
    </main>
  )
}
