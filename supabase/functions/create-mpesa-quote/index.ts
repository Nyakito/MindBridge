import { createAdminClient, getAuthenticatedUser, getMpesaConfig, jsonResponse } from '../_shared/mpesa.ts'

const usdKesUrl = 'https://open.er-api.com/v6/latest/USD'
const maxRateAgeSeconds = 24 * 60 * 60

function normalizeSafaricomPhone(value: unknown) {
  if (typeof value !== 'string') return null
  const compact = value.trim().replace(/[\s()-]/g, '')
  const match = compact.match(/^(?:\+?254|0)?([17][0-9]{8})$/)
  return match ? `254${match[1]}` : null
}

Deno.serve(async (request) => {
  const headers = jsonResponse({}, 200).headers
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)

  const config = getMpesaConfig()
  if (!config) return jsonResponse({ error: 'M-Pesa payment processing is not configured on the server.' }, 503)
  const user = await getAuthenticatedUser(request, config)
  if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400)
  }
  const phone = body && typeof body === 'object' && 'phone' in body
    ? normalizeSafaricomPhone(body.phone)
    : null
  if (!phone) {
    return jsonResponse({ error: 'Enter a Kenyan Safaricom phone number, such as 0712345678 or +254712345678.' }, 400)
  }

  const admin = createAdminClient(config)
  const { data: profile, error: profileError } = await admin.from('profiles')
    .select('role, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle()
  if (profileError || !profile || profile.role !== 'client' || !profile.onboarding_completed) {
    return jsonResponse({ error: 'Complete client onboarding before requesting a payment quote.' }, 403)
  }

  const { data: recentQuotes, error: recentQuotesError } = await admin.from('payments')
    .select('id')
    .eq('client_id', user.id)
    .eq('provider', 'mpesa')
    .gte('created_at', new Date(Date.now() - 60_000).toISOString())
    .limit(3)
  if (recentQuotesError) return jsonResponse({ error: 'Unable to verify quote request limits.' }, 500)
  if ((recentQuotes?.length ?? 0) >= 3) {
    return jsonResponse({ error: 'Too many quote requests. Please wait a minute and try again.' }, 429)
  }

  const { data: openPayments, error: openPaymentsError } = await admin.from('payments')
    .select('id, provider_session_id, mpesa_initiated_at, created_at')
    .eq('client_id', user.id)
    .eq('provider', 'mpesa')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10)
  if (openPaymentsError) return jsonResponse({ error: 'Unable to check existing payment requests.' }, 500)
  if (openPayments?.some((payment) => payment.provider_session_id || payment.mpesa_initiated_at)) {
    return jsonResponse({ error: 'A payment request is already in progress. Check its status before starting another.' }, 409)
  }
  const unstartedIds = (openPayments ?? []).map((payment) => payment.id)
  if (unstartedIds.length) {
    const { error } = await admin.from('payments')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .in('id', unstartedIds)
      .eq('status', 'pending')
    if (error) return jsonResponse({ error: 'Unable to replace the previous quote. Please try again.' }, 500)
  }

  let rate: number
  let rateUpdatedAt: string
  try {
    const response = await fetch(usdKesUrl, { signal: AbortSignal.timeout(8_000) })
    const result: unknown = await response.json()
    if (!response.ok || !result || typeof result !== 'object'
        || !('result' in result) || result.result !== 'success'
        || !('rates' in result) || !result.rates || typeof result.rates !== 'object'
        || !('KES' in result.rates) || typeof result.rates.KES !== 'number'
        || !Number.isFinite(result.rates.KES) || result.rates.KES <= 0
        || !('time_last_update_unix' in result) || typeof result.time_last_update_unix !== 'number'
        || !Number.isFinite(result.time_last_update_unix)) {
      return jsonResponse({ error: 'The current exchange rate is unavailable. Please try again later.' }, 502)
    }
    const updateTime = result.time_last_update_unix
    const ageSeconds = Date.now() / 1000 - updateTime
    if (ageSeconds < -300 || ageSeconds > maxRateAgeSeconds) {
      return jsonResponse({ error: 'The published exchange rate is too old to quote safely. Please try again later.' }, 503)
    }
    rate = Number(result.rates.KES.toFixed(8))
    rateUpdatedAt = new Date(updateTime * 1000).toISOString()
  } catch {
    return jsonResponse({ error: 'Unable to retrieve a current exchange rate. Please try again later.' }, 502)
  }

  const amountKes = Math.round(rate)
  const accountReference = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const { data: payment, error: paymentError } = await admin.from('payments')
    .insert({
      client_id: user.id,
      package: 'single_session',
      amount_cents: 100,
      currency: 'usd',
      provider: 'mpesa',
      mpesa_account_reference: accountReference,
      mpesa_phone: phone,
      mpesa_amount_kes: amountKes,
      mpesa_exchange_rate: rate,
      mpesa_rate_updated_at: rateUpdatedAt,
    })
    .select('id')
    .single()
  if (paymentError || !payment) {
    return jsonResponse({ error: 'Unable to save the payment quote. Please request a new quote.' }, 500)
  }

  return jsonResponse({
    paymentId: payment.id,
    phone,
    amountKes,
    exchangeRate: rate,
    rateUpdatedAt,
    quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  })
})
