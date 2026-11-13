import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export interface MpesaConfig {
  baseUrl: string
  consumerKey: string
  consumerSecret: string
  shortcode: string
  passkey: string
  callbackUrl: string
  projectUrl: string
  serviceRoleKey: string
}

export interface MpesaQueryResult {
  MerchantRequestID?: string
  CheckoutRequestID?: string
  ResponseCode?: string
  ResponseDescription?: string
  ResultCode?: string | number
  ResultDesc?: string
}

export function getMpesaConfig(): MpesaConfig | null {
  const environment = Deno.env.get('MPESA_ENVIRONMENT')
  const baseUrl = environment === 'production'
    ? 'https://api.safaricom.co.ke'
    : environment === 'sandbox'
      ? 'https://sandbox.safaricom.co.ke'
      : null
  const consumerKey = Deno.env.get('MPESA_CONSUMER_KEY')
  const consumerSecret = Deno.env.get('MPESA_CONSUMER_SECRET')
  const shortcode = Deno.env.get('MPESA_SHORTCODE')
  const passkey = Deno.env.get('MPESA_LIPA_NA_MPESA_PASSKEY')
  const callbackUrl = Deno.env.get('MPESA_CALLBACK_URL')
  const projectUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!baseUrl || !consumerKey || !consumerSecret || !shortcode || !passkey
      || !callbackUrl || !projectUrl || !serviceRoleKey) return null
  try {
    const callback = new URL(callbackUrl)
    if (callback.protocol !== 'https:' || callback.username || callback.password) return null
  } catch {
    return null
  }
  return { baseUrl, consumerKey, consumerSecret, shortcode, passkey, callbackUrl, projectUrl, serviceRoleKey }
}

export function createAdminClient(config: MpesaConfig) {
  return createClient(config.projectUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function darajaTimestamp(date = new Date()) {
  const values = new Map(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${values.get('year')}${values.get('month')}${values.get('day')}${values.get('hour')}${values.get('minute')}${values.get('second')}`
}

export function isValidTransactionDate(value: string) {
  const parts = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!parts) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31
      || hour > 23 || minute > 59 || second > 59) return false
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
}

export async function getAccessToken(config: MpesaConfig) {
  const response = await fetch(`${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: {
      Authorization: `Basic ${btoa(`${config.consumerKey}:${config.consumerSecret}`)}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  })
  const body: unknown = await response.json()
  if (!response.ok || !body || typeof body !== 'object'
      || !('access_token' in body) || typeof body.access_token !== 'string'
      || !body.access_token) {
    throw new Error('Daraja authentication failed.')
  }
  return body.access_token
}

export function stkPassword(config: MpesaConfig, timestamp: string) {
  return btoa(`${config.shortcode}${config.passkey}${timestamp}`)
}

export async function queryStk(
  config: MpesaConfig,
  accessToken: string,
  checkoutRequestId: string,
) {
  const timestamp = darajaTimestamp()
  const response = await fetch(`${config.baseUrl}/mpesa/stkpushquery/v1/query`, {
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
      CheckoutRequestID: checkoutRequestId,
    }),
    signal: AbortSignal.timeout(12_000),
  })
  const body: unknown = await response.json()
  if (!response.ok || !body || typeof body !== 'object') {
    throw new Error('Daraja payment status could not be verified.')
  }
  return body as MpesaQueryResult
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': Deno.env.get('SITE_URL') ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  }
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() })
}

export async function getAuthenticatedUser(request: Request, config: MpesaConfig) {
  const authorization = request.headers.get('Authorization')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!authorization || !anonKey) return null
  const client = createClient(config.projectUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.getUser()
  return error ? null : data.user
}
