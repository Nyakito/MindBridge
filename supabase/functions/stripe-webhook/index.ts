import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

function hexToBytes(value: string) {
  if (!/^[\da-f]+$/i.test(value) || value.length % 2 !== 0) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

async function signatureMatches(payload: string, header: string, secret: string) {
  const parts = header.split(',').map((part) => part.split('=', 2))
  const timestamp = parts.find(([key]) => key === 't')?.[1]
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value)
  if (!timestamp || signatures.length === 0) return false
  const timestampNumber = Number(timestamp)
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`)))
  return signatures.some((signature) => {
    const candidate = hexToBytes(signature)
    return candidate !== null && constantTimeEqual(candidate, expected)
  })
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const signingSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  const projectUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!signingSecret || !projectUrl || !serviceRoleKey) {
    return new Response('Webhook is not configured', { status: 503 })
  }

  const signature = request.headers.get('Stripe-Signature')
  const body = await request.text()
  if (!signature || !(await signatureMatches(body, signature, signingSecret))) {
    return new Response('Invalid signature', { status: 400 })
  }

  let event: {
    type: string
    data: { object: { id?: string; mode?: string; payment_status?: string; amount_total?: number; currency?: string; payment_intent?: string | { id: string }; metadata?: Record<string, string> } }
  }
  try {
    event = JSON.parse(body)
  } catch {
    return new Response('Invalid event payload', { status: 400 })
  }

  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return new Response(JSON.stringify({ received: true }), { status: 200 })
  }
  const session = event.data.object
  const paymentId = session.metadata?.payment_id
  const paymentIntent = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id
  if (!paymentId || !session.id || session.mode !== 'payment'
      || session.payment_status !== 'paid' || session.amount_total !== 100
      || session.currency?.toLowerCase() !== 'usd' || !paymentIntent
      || session.metadata?.package !== 'single_session') {
    return new Response('Payment is not complete', { status: 400 })
  }

  const adminClient = createClient(projectUrl, serviceRoleKey)
  const { error } = await adminClient.rpc('activate_paid_entitlement', {
    p_payment_id: paymentId,
    p_provider_session_id: session.id,
    p_provider_payment_id: paymentIntent,
    p_amount_total: session.amount_total,
    p_currency: session.currency,
  })
  if (error) return new Response('Unable to activate verified payment', { status: 500 })
  return new Response(JSON.stringify({ received: true }), { status: 200 })
})
