import {
  createAdminClient,
  getAccessToken,
  getAuthenticatedUser,
  getMpesaConfig,
  isValidTransactionDate,
  jsonResponse,
  queryStk,
} from '../_shared/mpesa.ts'

function isCallbackMetadata(value: unknown): value is {
  amount: number
  phone: string
  receipt: string
  transactionDate: string
} {
  return Boolean(value && typeof value === 'object'
    && 'amount' in value && typeof value.amount === 'number' && Number.isSafeInteger(value.amount)
    && 'phone' in value && typeof value.phone === 'string' && /^254[17][0-9]{8}$/.test(value.phone)
    && 'receipt' in value && typeof value.receipt === 'string' && /^[A-Z0-9]{8,12}$/.test(value.receipt)
    && 'transactionDate' in value && typeof value.transactionDate === 'string' && isValidTransactionDate(value.transactionDate))
}

function parseResultCode(value: string | number | undefined) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

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
  if (!/^[\da-f-]{36}$/i.test(paymentId)) return jsonResponse({ error: 'Invalid payment reference.' }, 400)

  const admin = createAdminClient(config)
  const { data: payment, error: paymentError } = await admin.from('payments')
    .select('id, status, provider, provider_session_id, mpesa_merchant_request_id, mpesa_amount_kes, mpesa_phone, mpesa_callback_metadata')
    .eq('id', paymentId)
    .eq('client_id', user.id)
    .maybeSingle()
  if (paymentError || !payment || payment.provider !== 'mpesa') {
    return jsonResponse({ error: 'M-Pesa payment was not found.' }, 404)
  }
  if (payment.status !== 'pending') return jsonResponse({ status: payment.status })
  if (!payment.provider_session_id || !payment.mpesa_merchant_request_id) {
    return jsonResponse({
      status: 'pending',
      message: 'The payment request has not been registered with Daraja yet. Do not retry the STK Push; contact support if it does not update.',
    })
  }

  const { data: claimed, error: claimError } = await admin.rpc('claim_mpesa_status_query', {
    p_payment_id: payment.id,
  })
  if (claimError) return jsonResponse({ error: 'Unable to start a payment status check.' }, 500)
  if (claimed !== true) {
    return jsonResponse({ status: 'pending', message: 'A status check is already in progress. Try again in a few seconds.' })
  }

  try {
    const token = await getAccessToken(config)
    const query = await queryStk(config, token, payment.provider_session_id)
    if (query.CheckoutRequestID !== payment.provider_session_id
        || (query.MerchantRequestID && query.MerchantRequestID !== payment.mpesa_merchant_request_id)) {
      return jsonResponse({ status: 'pending', message: 'Daraja has not returned a matching confirmation yet.' })
    }
    const verifiedResult = parseResultCode(query.ResultCode)
    if (verifiedResult === 0 && isCallbackMetadata(payment.mpesa_callback_metadata)
        && payment.mpesa_callback_metadata.amount === payment.mpesa_amount_kes
        && payment.mpesa_callback_metadata.phone === payment.mpesa_phone) {
      const { error } = await admin.rpc('activate_mpesa_entitlement', {
        p_payment_id: payment.id,
        p_checkout_request_id: payment.provider_session_id,
        p_merchant_request_id: payment.mpesa_merchant_request_id,
        p_amount_kes: payment.mpesa_callback_metadata.amount,
        p_phone: payment.mpesa_callback_metadata.phone,
        p_receipt: payment.mpesa_callback_metadata.receipt,
        p_transaction_date: payment.mpesa_callback_metadata.transactionDate,
      })
      if (error) return jsonResponse({ error: 'Verified payment could not be activated. Please contact support.' }, 500)
      return jsonResponse({ status: 'successful' })
    }
    if (verifiedResult === 1032) {
      const { error } = await admin.rpc('fail_mpesa_payment', {
        p_payment_id: payment.id,
        p_checkout_request_id: payment.provider_session_id,
        p_result_code: verifiedResult,
      })
      if (error) return jsonResponse({ error: 'Unable to save the provider-confirmed cancellation.' }, 500)
      return jsonResponse({ status: 'failed' })
    }
    return jsonResponse({
      status: 'pending',
      message: verifiedResult === 0
        ? 'Daraja confirmed payment, but its callback receipt details have not arrived yet.'
        : 'Payment is still being processed. You can check again shortly.',
    })
  } catch {
    return jsonResponse({
      status: 'pending',
      message: 'Daraja status is temporarily unavailable. Your payment remains pending; try again shortly.',
    })
  }
})
