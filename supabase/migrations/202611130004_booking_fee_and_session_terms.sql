alter table public.therapists
  add column if not exists session_terms text not null default '';

alter table public.therapists
  drop constraint if exists therapists_session_terms_length;
alter table public.therapists
  add constraint therapists_session_terms_length
  check (char_length(session_terms) <= 5000);

alter table public.appointments
  add column if not exists accepted_session_terms text not null default '',
  add column if not exists session_terms_accepted_at timestamptz,
  add column if not exists accepted_session_fee_cents integer not null default 0
    check (accepted_session_fee_cents >= 0),
  add column if not exists platform_fee_cents integer not null default 0
    check (platform_fee_cents >= 0);

create or replace function public.enforce_booking_fee_payment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.package <> 'single_session'
     or new.amount_cents <> 100
     or new.currency <> 'usd' then
    raise exception 'Only the USD 1.00 booking platform fee is available';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_booking_fee_payment_insert on public.payments;
create trigger enforce_booking_fee_payment_insert
  before insert on public.payments
  for each row execute procedure public.enforce_booking_fee_payment();
drop trigger if exists enforce_booking_fee_payment_update on public.payments;
create trigger enforce_booking_fee_payment_update
  before update of package, amount_cents, currency on public.payments
  for each row execute procedure public.enforce_booking_fee_payment();

update public.client_entitlements
set remaining_sessions = 0
where kind = 'free_session' and remaining_sessions > 0;

create or replace function public.can_browse_therapists()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'client'
      and p.onboarding_completed
      and exists (
        select 1 from public.agreement_acceptances aa
        where aa.user_id = p.id and aa.agreement_type = 'client'
      )
  );
$$;

create or replace function public.complete_onboarding(p_agreement_version text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_role public.user_role;
  agreement_kind text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_agreement_version <> 'mindbridge-terms-v1' then
    raise exception 'Unsupported agreement version';
  end if;
  select role into current_role from public.profiles where id = auth.uid() for update;
  if current_role is null then raise exception 'Account profile not found'; end if;
  agreement_kind := case when current_role = 'therapist' then 'therapist' else 'client' end;

  insert into public.agreement_acceptances(user_id, agreement_type, agreement_version)
  values (auth.uid(), agreement_kind, p_agreement_version)
  on conflict (user_id, agreement_type, agreement_version) do nothing;

  perform set_config('mindbridge.allow_onboarding', 'true', true);
  update public.profiles set onboarding_completed = true where id = auth.uid();
  perform set_config('mindbridge.allow_onboarding', 'false', true);
end;
$$;

create or replace function public.get_client_access()
returns table (
  has_directory_access boolean,
  free_sessions_remaining integer,
  bookable_sessions_remaining integer,
  membership_expires_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.can_browse_therapists(),
    0::integer,
    coalesce(sum(e.remaining_sessions) filter (
      where e.kind = 'single_session'
        and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
    ), 0)::integer,
    max(e.expires_at) filter (
      where e.kind in ('weekly_access', 'monthly_access') and e.expires_at > now()
    )
  from public.client_entitlements e
  where e.client_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'client');
$$;

drop function if exists public.book_appointment(uuid);
create function public.book_appointment(
  p_availability_id uuid,
  p_terms_accepted boolean,
  p_accepted_session_terms text,
  p_displayed_session_fee_cents integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  slot public.therapist_availability%rowtype;
  therapist_record public.therapists%rowtype;
  selected_entitlement public.client_entitlements%rowtype;
  appointment_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'client' and p.onboarding_completed
  ) then raise exception 'Complete client onboarding before booking'; end if;
  if not exists (
    select 1 from public.agreement_acceptances aa
    where aa.user_id = auth.uid() and aa.agreement_type = 'client'
  ) then raise exception 'Accept the client agreement before booking'; end if;

  select * into slot from public.therapist_availability
    where id = p_availability_id for update;
  if not found or slot.is_booked or slot.starts_at <= now() then
    raise exception 'This appointment time is no longer available';
  end if;

  select * into therapist_record from public.therapists
    where id = slot.therapist_id and verification_status = 'approved'
    for share;
  if not found then raise exception 'This therapist is not available for bookings'; end if;
  if char_length(trim(therapist_record.session_terms)) = 0 then
    raise exception 'This therapist has not published session terms yet';
  end if;
  if p_terms_accepted is not true then
    raise exception 'Review and accept the therapist''s current session terms before booking';
  end if;
  if p_accepted_session_terms is distinct from therapist_record.session_terms then
    raise exception 'The therapist''s session terms have changed. Review them before booking';
  end if;
  if p_displayed_session_fee_cents is distinct from therapist_record.session_fee_cents then
    raise exception 'The therapist''s session fee has changed. Review it before booking';
  end if;

  select * into selected_entitlement
  from public.client_entitlements e
  where e.client_id = auth.uid()
    and e.starts_at <= now()
    and (e.expires_at is null or e.expires_at > now())
    and e.kind = 'single_session'
    and e.remaining_sessions > 0
  order by e.created_at
  limit 1 for update;

  if not found then
    raise exception 'A USD 1.00 booking platform fee entitlement is required';
  end if;

  update public.client_entitlements
    set remaining_sessions = remaining_sessions - 1
    where id = selected_entitlement.id;

  update public.therapist_availability set is_booked = true where id = slot.id;
  insert into public.appointments(
    availability_id, client_id, therapist_id, starts_at, ends_at,
    price_cents, entitlement_id, accepted_session_terms,
    session_terms_accepted_at, accepted_session_fee_cents, platform_fee_cents
  )
  values (
    slot.id, auth.uid(), slot.therapist_id, slot.starts_at, slot.ends_at,
    100, selected_entitlement.id, therapist_record.session_terms, now(),
    therapist_record.session_fee_cents, 100
  )
  returning id into appointment_id;
  return appointment_id;
end;
$$;

drop function if exists public.activate_paid_entitlement(uuid, text, text);
create function public.activate_paid_entitlement(
  p_payment_id uuid,
  p_provider_session_id text,
  p_provider_payment_id text,
  p_amount_total integer,
  p_currency text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  paid_record public.payments%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_amount_total is distinct from 100 or lower(coalesce(p_currency, '')) <> 'usd' then
    raise exception 'Checkout amount or currency does not match the booking fee';
  end if;

  select * into paid_record from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment record not found'; end if;
  if paid_record.status = 'successful' then return; end if;
  if paid_record.status <> 'pending' then raise exception 'Payment is not pending'; end if;
  if paid_record.package <> 'single_session' or paid_record.amount_cents <> 100
     or paid_record.currency <> 'usd' then
    raise exception 'Payment record does not match the booking fee';
  end if;
  if paid_record.provider_session_id is null or paid_record.provider_session_id <> p_provider_session_id then
    raise exception 'Payment session does not match the recorded checkout';
  end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'Verified payment intent is required';
  end if;

  update public.payments
    set status = 'successful', provider_payment_id = p_provider_payment_id, updated_at = now()
    where id = paid_record.id;
  insert into public.client_entitlements(
    client_id, kind, remaining_sessions, expires_at, source_payment_id
  )
  values (paid_record.client_id, 'single_session', 1, null, paid_record.id)
  on conflict (source_payment_id) do nothing;
end;
$$;

revoke all on function public.enforce_booking_fee_payment() from public, anon, authenticated;
revoke all on function public.activate_paid_entitlement(uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.activate_paid_entitlement(uuid, text, text, integer, text) to service_role;
revoke all on function public.complete_onboarding(text) from public, anon;
revoke all on function public.get_client_access() from public, anon;
revoke all on function public.book_appointment(uuid, boolean, text, integer) from public, anon;
revoke all on function public.can_browse_therapists() from public, anon;
grant execute on function public.complete_onboarding(text) to authenticated;
grant execute on function public.get_client_access() to authenticated;
grant execute on function public.book_appointment(uuid, boolean, text, integer) to authenticated;
grant execute on function public.can_browse_therapists() to authenticated;
