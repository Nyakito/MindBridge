import {
  createAdminClient,
  darajaTimestamp,
  getAccessToken,
  getAuthenticatedUser,
  getMpesaConfig,
  jsonResponse,
  stkPassword,
} from '../_shared/mpesa.ts'

Deno.serve(async (request) => {
  const headers = jsonResponse({}, 200).headers
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)

  const config = getMpesaConfig()
  if (!config) return jsonResponse({ error: 'M-Pesa payment processing is not configured on the server.' }, 503)
  const user = await getAuthenticatedUser(request, config)
  if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)

  let paymentId = ''
  try {
    const body: unknown = await request.json()
    if (body && typeof body === 'object' && 'paymentId' in body && typeof body.paymentId === 'string') {
      paymentId = body.paymentId
    }
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400)
  }
  if (!/^[\da-f-]{36}$/i.test(paymentId)) return jsonResponse({ error: 'Invalid payment quote.' }, 400)

  const admin = createAdminClient(config)
  const { data: profile } = await admin.from('profiles')
    .select('role, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile || profile.role !== 'client' || !profile.onboarding_completed) {
    return jsonResponse({ error: 'Complete client onboarding before requesting an STK Push.' }, 403)
  }
  const { data: payment, error: paymentError } = await admin.from('payments')
    .select('id, client_id, package, amount_cents, currency, provider, provider_session_id, mpesa_phone, mpesa_amount_kes, mpesa_account_reference, mpesa_initiated_at, created_at')
    .eq('id', paymentId)
    .eq('client_id', user.id)
    .maybeSingle()
  if (paymentError || !payment) return jsonResponse({ error: 'Payment quote was not found.' }, 404)
  if (payment.provider !== 'mpesa' || payment.package !== 'single_session'
      || payment.amount_cents !== 100 || payment.currency !== 'usd'
      || !payment.mpesa_phone || !payment.mpesa_amount_kes || !payment.mpesa_account_reference) {
    return jsonResponse({ error: 'Payment quote is invalid.' }, 400)
  }
  if (payment.provider_session_id || payment.mpesa_initiated_at) {
    return jsonResponse({ error: 'This payment request has already been submitted. Check its status before continuing.' }, 409)
  }
  if (Date.now() - new Date(payment.created_at).getTime() > 15 * 60 * 1000) {
    return jsonResponse({ error: 'This quote has expired. Request a fresh quote before paying.' }, 410)
  }

  const { data: claimed, error: claimError } = await admin.rpc('claim_mpesa_payment', {
    p_payment_id: payment.id,
  })
  if (claimError || claimed !== true) {
    return jsonResponse({ error: 'This payment request could not be submitted. Refresh its status or request a new quote.' }, 409)
  }

  let accessToken: string
  try {
    accessToken = await getAccessToken(config)
  } catch {
    await admin.from('payments').update({ mpesa_initiated_at: null })
      .eq('id', payment.id).eq('status', 'pending').is('provider_session_id', null)
    return jsonResponse({ error: 'Daraja authentication is temporarily unavailable. Request the STK Push again shortly.' }, 502)
  }

  try {
    const timestamp = darajaTimestamp()
    const response = await fetch(`${config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: config.shortcode,
        Password: stkPassword(config, timestamp),
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: payment.mpesa_amount_kes,
        PartyA: payment.mpesa_phone,
        PartyB: config.shortcode,
        PhoneNumber: payment.mpesa_phone,
        CallBackURL: config.callbackUrl,
        AccountReference: payment.mpesa_account_reference,
        TransactionDesc: 'Booking fee',
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const result: unknown = await response.json()
    const accepted = response.ok && result && typeof result === 'object'
      && 'ResponseCode' in result && result.ResponseCode === '0'
      && 'CheckoutRequestID' in result && typeof result.CheckoutRequestID === 'string'
      && result.CheckoutRequestID.length > 0
      && 'MerchantRequestID' in result && typeof result.MerchantRequestID === 'string'
      && result.MerchantRequestID.length > 0
    if (!accepted) {
      if (response.ok && result && typeof result === 'object'
          && 'ResponseCode' in result && typeof result.ResponseCode === 'string'
          && result.ResponseCode !== '0') {
        await admin.from('payments').update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', payment.id).eq('status', 'pending')
      }
      return jsonResponse({
        error: response.ok
          ? 'Daraja did not accept the payment request. If you received an STK prompt, check payment status before retrying.'
          : 'Unable to confirm that Daraja accepted the payment request. Check payment status before retrying.',
      }, response.ok ? 502 : 503)
    }

    const providerResult = result as { CheckoutRequestID: string; MerchantRequestID: string }
    const { data: savedPayment, error: saveError } = await admin.from('payments').update({
      provider_session_id: providerResult.CheckoutRequestID,
      mpesa_merchant_request_id: providerResult.MerchantRequestID,
      updated_at: new Date().toISOString(),
    }).eq('id', payment.id).eq('status', 'pending').is('provider_session_id', null).select('id').maybeSingle()
    if (saveError || !savedPayment) {
      return jsonResponse({ error: 'Daraja accepted the request, but its reference could not be saved. Do not retry; contact support with your payment quote.' }, 500)
    }
    return jsonResponse({ paymentId: payment.id, status: 'pending', message: 'STK Push sent. Complete the prompt on your phone, then check payment status.' })
  } catch {
    return jsonResponse({
      error: 'The result from Daraja is not yet known. Do not submit another request; check payment status or contact support.',
    }, 503)
  }
})
