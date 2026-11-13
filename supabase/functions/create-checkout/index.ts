const headers = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_URL') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

Deno.serve((request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  return new Response(JSON.stringify({ error: 'Stripe checkout is retired. Use the M-Pesa booking-fee flow.' }), {
    status: 410,
    headers,
  })
})
