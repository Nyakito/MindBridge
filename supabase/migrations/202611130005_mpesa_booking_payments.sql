alter table public.payments
  add column if not exists mpesa_account_reference text,
  add column if not exists mpesa_phone text,
  add column if not exists mpesa_amount_kes integer,
  add column if not exists mpesa_exchange_rate numeric(18, 8),
  add column if not exists mpesa_rate_updated_at timestamptz,
  add column if not exists mpesa_initiated_at timestamptz,
  add column if not exists mpesa_last_query_at timestamptz,
  add column if not exists mpesa_merchant_request_id text,
  add column if not exists mpesa_receipt text,
  add column if not exists mpesa_transaction_at timestamptz,
  add column if not exists mpesa_callback_metadata jsonb;

create unique index if not exists payments_mpesa_account_reference_uidx
  on public.payments(mpesa_account_reference)
  where mpesa_account_reference is not null;

create unique index if not exists payments_mpesa_receipt_uidx
  on public.payments(mpesa_receipt)
  where mpesa_receipt is not null;

alter table public.payments
  drop constraint if exists payments_mpesa_quote_valid;
alter table public.payments
  add constraint payments_mpesa_quote_valid check (
    provider <> 'mpesa' or (
      package = 'single_session'
      and amount_cents = 100
      and currency = 'usd'
      and mpesa_account_reference is not null
      and mpesa_phone is not null
      and mpesa_phone ~ '^254[17][0-9]{8}$'
      and mpesa_amount_kes is not null
      and mpesa_amount_kes > 0
      and mpesa_exchange_rate is not null
      and mpesa_exchange_rate > 0
      and mpesa_amount_kes = round(mpesa_exchange_rate)::integer
      and mpesa_rate_updated_at is not null
    )
  ) not valid;
alter table public.payments validate constraint payments_mpesa_quote_valid;

create or replace function public.activate_mpesa_entitlement(
  p_payment_id uuid,
  p_checkout_request_id text,
  p_merchant_request_id text,
  p_amount_kes integer,
  p_phone text,
  p_receipt text,
  p_transaction_date text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  paid_record public.payments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_checkout_request_id is null or length(trim(p_checkout_request_id)) = 0
     or p_merchant_request_id is null or length(trim(p_merchant_request_id)) = 0
     or p_receipt is null
     or p_receipt !~ '^[A-Z0-9]{8,12}$'
     or p_transaction_date is null
     or p_transaction_date !~ '^[0-9]{14}$'
     or p_phone is null
     or p_phone !~ '^254[17][0-9]{8}$' then
    raise exception 'M-Pesa confirmation details are invalid';
  end if;

  select * into paid_record
  from public.payments
  where id = p_payment_id
  for update;
  if not found then raise exception 'Payment record not found'; end if;

  if paid_record.status = 'successful' then
    if paid_record.provider = 'mpesa'
       and paid_record.provider_session_id = p_checkout_request_id
       and paid_record.mpesa_merchant_request_id = p_merchant_request_id
       and paid_record.mpesa_amount_kes = p_amount_kes
       and paid_record.mpesa_phone = p_phone
       and paid_record.mpesa_receipt = p_receipt
       and paid_record.mpesa_callback_metadata = jsonb_build_object(
         'amount', p_amount_kes,
         'phone', p_phone,
         'receipt', p_receipt,
         'transactionDate', p_transaction_date
       ) then
      return;
    end if;
    raise exception 'Payment was already completed with different details';
  end if;

  if paid_record.status <> 'pending'
     or paid_record.provider <> 'mpesa'
     or paid_record.package <> 'single_session'
     or paid_record.amount_cents <> 100
     or paid_record.currency <> 'usd'
     or paid_record.provider_session_id is distinct from p_checkout_request_id
     or paid_record.mpesa_merchant_request_id is distinct from p_merchant_request_id
     or paid_record.mpesa_amount_kes is distinct from p_amount_kes
     or paid_record.mpesa_phone is distinct from p_phone
     or paid_record.mpesa_callback_metadata is distinct from jsonb_build_object(
       'amount', p_amount_kes,
       'phone', p_phone,
       'receipt', p_receipt,
       'transactionDate', p_transaction_date
     ) then
    raise exception 'M-Pesa confirmation does not match the recorded checkout';
  end if;

  update public.payments
    set status = 'successful',
        provider_payment_id = p_receipt,
        mpesa_receipt = p_receipt,
        mpesa_transaction_at = make_timestamptz(
          substring(p_transaction_date, 1, 4)::integer,
          substring(p_transaction_date, 5, 2)::integer,
          substring(p_transaction_date, 7, 2)::integer,
          substring(p_transaction_date, 9, 2)::integer,
          substring(p_transaction_date, 11, 2)::integer,
          substring(p_transaction_date, 13, 2)::double precision,
          'Africa/Nairobi'
        ),
        updated_at = now()
    where id = paid_record.id;

  insert into public.client_entitlements(
    client_id, kind, remaining_sessions, expires_at, source_payment_id
  )
  values (paid_record.client_id, 'single_session', 1, null, paid_record.id)
  on conflict (source_payment_id) do nothing;
end;
$$;

create or replace function public.fail_mpesa_payment(
  p_payment_id uuid,
  p_checkout_request_id text,
  p_result_code integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment_record public.payments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_result_code is distinct from 1032 then
    raise exception 'Only provider-confirmed customer cancellation may fail this payment';
  end if;

  select * into payment_record
  from public.payments
  where id = p_payment_id
  for update;
  if not found then raise exception 'Payment record not found'; end if;
  if payment_record.status = 'successful' then return; end if;
  if payment_record.status = 'pending'
     and payment_record.provider = 'mpesa'
     and payment_record.provider_session_id = p_checkout_request_id then
    update public.payments
      set status = 'failed', updated_at = now()
      where id = payment_record.id;
  end if;
end;
$$;

create or replace function public.claim_mpesa_payment(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment_record public.payments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select * into payment_record
  from public.payments
  where id = p_payment_id
  for update;
  if not found or payment_record.status <> 'pending'
     or payment_record.provider <> 'mpesa'
     or payment_record.provider_session_id is not null
     or payment_record.mpesa_initiated_at is not null
     or payment_record.created_at < now() - interval '15 minutes' then
    return false;
  end if;
  update public.payments
    set mpesa_initiated_at = now(), updated_at = now()
    where id = p_payment_id;
  return true;
end;
$$;

create or replace function public.claim_mpesa_status_query(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment_record public.payments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select * into payment_record
  from public.payments
  where id = p_payment_id
  for update;
  if not found or payment_record.status <> 'pending'
     or payment_record.provider <> 'mpesa'
     or payment_record.provider_session_id is null
     or payment_record.mpesa_last_query_at > now() - interval '15 seconds' then
    return false;
  end if;
  update public.payments
    set mpesa_last_query_at = now()
    where id = p_payment_id;
  return true;
end;
$$;

revoke all on function public.activate_mpesa_entitlement(uuid, text, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.activate_mpesa_entitlement(uuid, text, text, integer, text, text, text)
  to service_role;
revoke all on function public.fail_mpesa_payment(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.fail_mpesa_payment(uuid, text, integer)
  to service_role;
revoke all on function public.claim_mpesa_payment(uuid) from public, anon, authenticated;
grant execute on function public.claim_mpesa_payment(uuid) to service_role;
revoke all on function public.claim_mpesa_status_query(uuid) from public, anon, authenticated;
grant execute on function public.claim_mpesa_status_query(uuid) to service_role;

comment on column public.payments.mpesa_amount_kes is
  'Exact whole-KES checkout quote for the USD 1 MindBridge booking entitlement.';
comment on column public.payments.mpesa_exchange_rate is
  'USD/KES rate used for the quote, sourced from the exchange-rate provider.';
comment on column public.payments.mpesa_callback_metadata is
  'Untrusted, validated callback fields retained only for retrying server-side STK Query confirmation.';
