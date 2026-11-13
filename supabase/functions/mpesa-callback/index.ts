import {
  createAdminClient,
  getAccessToken,
  getMpesaConfig,
  isValidTransactionDate,
  queryStk,
} from '../_shared/mpesa.ts'

interface CallbackMetadata {
  amount: number
  phone: string
  receipt: string
  transactionDate: string
}

function extractMetadata(items: unknown): CallbackMetadata | null {
  if (!Array.isArray(items)) return null
  const values = new Map<string, unknown>()
  for (const item of items) {
    if (item && typeof item === 'object' && 'Name' in item && typeof item.Name === 'string' && 'Value' in item) {
      values.set(item.Name, item.Value)
    }
  }
  const amount = values.get('Amount')
  const receipt = values.get('MpesaReceiptNumber')
  const phone = values.get('PhoneNumber')
  const transactionDate = values.get('TransactionDate')
  const amountNumber = typeof amount === 'number' ? amount : Number(amount)
  const phoneText = typeof phone === 'number' || typeof phone === 'string' ? String(phone) : ''
  const transactionText = typeof transactionDate === 'number' || typeof transactionDate === 'string'
    ? String(transactionDate).padStart(14, '0')
    : ''
  if (!Number.isSafeInteger(amountNumber) || typeof receipt !== 'string'
      || !/^[A-Z0-9]{8,12}$/.test(receipt)
      || !/^254[17][0-9]{8}$/.test(phoneText)
      || !isValidTransactionDate(transactionText)) return null
  return { amount: amountNumber, phone: phoneText, receipt, transactionDate: transactionText }
}

function resultCode(value: string | number | undefined) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const config = getMpesaConfig()
  if (!config) return new Response('Callback is not configured', { status: 503 })
  let payload: unknown
  try {
    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).byteLength > 16_384) {
      return new Response('Payload too large', { status: 413 })
    }
    payload = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid callback payload', { status: 400 })
  }
  const stkCallback = payload && typeof payload === 'object'
    && 'Body' in payload && payload.Body && typeof payload.Body === 'object'
    && 'stkCallback' in payload.Body
    ? payload.Body.stkCallback
    : null
  if (!stkCallback || typeof stkCallback !== 'object'
      || !('CheckoutRequestID' in stkCallback) || typeof stkCallback.CheckoutRequestID !== 'string'
      || !('MerchantRequestID' in stkCallback) || typeof stkCallback.MerchantRequestID !== 'string') {
    return new Response('Invalid callback reference', { status: 400 })
  }
  const checkoutRequestId = stkCallback.CheckoutRequestID
  const merchantRequestId = stkCallback.MerchantRequestID
  const callbackResultCode = 'ResultCode' in stkCallback ? resultCode(stkCallback.ResultCode as string | number) : null
  const callbackDetails = callbackResultCode === 0 && 'CallbackMetadata' in stkCallback
    && stkCallback.CallbackMetadata && typeof stkCallback.CallbackMetadata === 'object'
    && 'Item' in stkCallback.CallbackMetadata
    ? extractMetadata(stkCallback.CallbackMetadata.Item)
    : null

  const admin = createAdminClient(config)
  const { data: payment, error: paymentError } = await admin.from('payments')
    .select('id, status, provider_session_id, mpesa_merchant_request_id, mpesa_amount_kes, mpesa_phone')
    .eq('provider', 'mpesa')
    .eq('provider_session_id', checkoutRequestId)
    .maybeSingle()
  if (paymentError || !payment || payment.status !== 'pending'
      || payment.mpesa_merchant_request_id !== merchantRequestId) {
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Callback acknowledged' }), { status: 200 })
  }

  if (callbackDetails
      && callbackDetails.amount === payment.mpesa_amount_kes
      && callbackDetails.phone === payment.mpesa_phone) {
    const { error } = await admin.from('payments').update({
      mpesa_callback_metadata: callbackDetails,
      updated_at: new Date().toISOString(),
    }).eq('id', payment.id).eq('status', 'pending')
    if (error) return new Response('Callback metadata could not be saved', { status: 500 })
  }

  const { data: claimed, error: claimError } = await admin.rpc('claim_mpesa_status_query', {
    p_payment_id: payment.id,
  })
  if (claimError || claimed !== true) {
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Callback acknowledged for status reconciliation' }), { status: 200 })
  }

  try {
    const token = await getAccessToken(config)
    const query = await queryStk(config, token, checkoutRequestId)
    if (query.CheckoutRequestID !== checkoutRequestId
        || (query.MerchantRequestID && query.MerchantRequestID !== merchantRequestId)) {
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Callback acknowledged' }), { status: 200 })
    }
    const verifiedResult = resultCode(query.ResultCode)
    if (verifiedResult === 0 && callbackDetails
        && callbackDetails.amount === payment.mpesa_amount_kes
        && callbackDetails.phone === payment.mpesa_phone) {
      const { error } = await admin.rpc('activate_mpesa_entitlement', {
        p_payment_id: payment.id,
        p_checkout_request_id: checkoutRequestId,
        p_merchant_request_id: merchantRequestId,
        p_amount_kes: callbackDetails.amount,
        p_phone: callbackDetails.phone,
        p_receipt: callbackDetails.receipt,
        p_transaction_date: callbackDetails.transactionDate,
      })
      if (error) return new Response('Payment confirmation could not be saved', { status: 500 })
    } else if (verifiedResult === 1032) {
      await admin.rpc('fail_mpesa_payment', {
        p_payment_id: payment.id,
        p_checkout_request_id: checkoutRequestId,
        p_result_code: verifiedResult,
      })
    }
  } catch {
    // Keep the payment pending so the authorized status endpoint can retry provider verification.
  }
  return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Callback processed' }), { status: 200 })
})
