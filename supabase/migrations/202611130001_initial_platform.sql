create extension if not exists pgcrypto;
create extension if not exists btree_gist;

do $$ begin
  create type public.user_role as enum ('client', 'therapist', 'admin');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.verification_status as enum ('pending', 'under_review', 'approved', 'rejected', 'suspended');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.appointment_status as enum ('confirmed', 'cancelled', 'completed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.entitlement_kind as enum ('free_session', 'single_session', 'weekly_access', 'monthly_access');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null default 'client',
  full_name text not null default '',
  phone text,
  country text,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.therapists (
  id uuid primary key references public.profiles(id) on delete cascade,
  full_name text not null,
  professional_title text not null default '',
  biography text not null default '',
  qualifications text[] not null default '{}',
  specializations text[] not null default '{}',
  languages text[] not null default '{}',
  years_experience integer not null default 0 check (years_experience >= 0),
  session_duration_minutes integer not null default 50 check (session_duration_minutes between 15 and 240),
  session_fee_cents integer not null default 1000 check (session_fee_cents > 0),
  consultation_format text not null default 'online' check (consultation_format in ('online', 'in_person', 'both')),
  verification_status public.verification_status not null default 'pending',
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agreement_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  agreement_type text not null check (agreement_type in ('client', 'therapist')),
  agreement_version text not null,
  accepted_at timestamptz not null default now(),
  unique (user_id, agreement_type, agreement_version)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id),
  package public.entitlement_kind not null check (package <> 'free_session'),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd' check (currency = 'usd'),
  status text not null default 'pending' check (status in ('pending', 'successful', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  provider text not null default 'stripe',
  provider_session_id text unique,
  provider_payment_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_entitlements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  kind public.entitlement_kind not null,
  remaining_sessions integer,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  source_payment_id uuid unique references public.payments(id),
  created_at timestamptz not null default now(),
  check (remaining_sessions is null or remaining_sessions >= 0),
  check ((kind in ('free_session', 'single_session') and remaining_sessions is not null)
      or (kind in ('weekly_access', 'monthly_access') and remaining_sessions is null))
);

create unique index if not exists one_free_entitlement_per_client
  on public.client_entitlements(client_id) where kind = 'free_session';

create table if not exists public.therapist_availability (
  id uuid primary key default gen_random_uuid(),
  therapist_id uuid not null references public.therapists(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_booked boolean not null default false,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  exclude using gist (
    therapist_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  availability_id uuid not null unique references public.therapist_availability(id),
  client_id uuid not null references public.profiles(id),
  therapist_id uuid not null references public.therapists(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.appointment_status not null default 'confirmed',
  price_cents integer not null check (price_cents >= 0),
  entitlement_id uuid references public.client_entitlements(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  client_id uuid not null references public.profiles(id),
  therapist_id uuid not null references public.therapists(id),
  rating integer not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 10 and 2000),
  therapist_response text,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_activity (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id),
  action text not null,
  subject_type text not null,
  subject_id uuid,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists appointments_client_start_idx on public.appointments(client_id, starts_at);
create index if not exists appointments_therapist_start_idx on public.appointments(therapist_id, starts_at);
create index if not exists availability_therapist_start_idx on public.therapist_availability(therapist_id, starts_at) where not is_booked;
create index if not exists entitlement_client_expiry_idx on public.client_entitlements(client_id, expires_at);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_role public.user_role;
  new_name text;
begin
  requested_role := case
    when new.raw_user_meta_data ->> 'account_type' = 'therapist' then 'therapist'::public.user_role
    else 'client'::public.user_role
  end;
  new_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), '');

  insert into public.profiles (id, role, full_name)
  values (new.id, requested_role, new_name);

  if requested_role = 'therapist' then
    insert into public.therapists (id, full_name)
    values (new.id, new_name);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() = old.id and coalesce(current_setting('role', true), '') <> 'service_role' then
    if new.role <> old.role then
      raise exception 'Profile role cannot be changed directly';
    end if;
    if new.onboarding_completed <> old.onboarding_completed
       and coalesce(current_setting('mindbridge.allow_onboarding', true), '') <> 'true' then
      raise exception 'Complete onboarding through the approved workflow';
    end if;
    if new.id <> old.id or new.created_at <> old.created_at then
      raise exception 'Protected profile fields cannot be changed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute procedure public.protect_profile_fields();

create or replace function public.protect_therapist_verification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() = old.id and coalesce(current_setting('role', true), '') <> 'service_role'
     and new.verification_status <> old.verification_status then
    raise exception 'Therapist verification can only be changed by an administrator';
  end if;
  if new.verification_status = 'approved'
     and (trim(new.professional_title) = '' or trim(new.biography) = '' or cardinality(new.qualifications) = 0) then
    raise exception 'A complete profile and qualifications are required before approval';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_therapist_verification on public.therapists;
create trigger protect_therapist_verification
  before update on public.therapists
  for each row execute procedure public.protect_therapist_verification();

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
      and (
        exists (
          select 1 from public.client_entitlements e
          where e.client_id = p.id
            and e.starts_at <= now()
            and (e.expires_at is null or e.expires_at > now())
            and ((e.kind in ('free_session', 'single_session') and e.remaining_sessions > 0)
              or e.kind in ('weekly_access', 'monthly_access'))
        )
      )
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
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

  if current_role = 'client' then
    insert into public.client_entitlements(client_id, kind, remaining_sessions)
    values (auth.uid(), 'free_session', 1)
    on conflict (client_id) where kind = 'free_session' do nothing;
  end if;
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
    coalesce(bool_or(
      e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
      and ((e.kind in ('free_session', 'single_session') and e.remaining_sessions > 0)
        or e.kind in ('weekly_access', 'monthly_access'))
    ), false),
    coalesce(sum(e.remaining_sessions) filter (
      where e.kind = 'free_session' and e.expires_at is null
    ), 0)::integer,
    coalesce(sum(e.remaining_sessions) filter (
      where e.kind in ('free_session', 'single_session')
        and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
    ), 0)::integer,
    max(e.expires_at) filter (
      where e.kind in ('weekly_access', 'monthly_access') and e.expires_at > now()
    )
  from public.client_entitlements e
  where e.client_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'client');
$$;

create or replace function public.book_appointment(p_availability_id uuid)
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
    where id = slot.therapist_id and verification_status = 'approved';
  if not found then raise exception 'This therapist is not available for bookings'; end if;

  select * into selected_entitlement
  from public.client_entitlements e
  where e.client_id = auth.uid()
    and e.starts_at <= now()
    and (e.expires_at is null or e.expires_at > now())
    and e.kind in ('free_session', 'single_session')
    and e.remaining_sessions > 0
  order by case e.kind when 'free_session' then 0 else 1 end, e.created_at
  limit 1 for update;

  if found then
    update public.client_entitlements
      set remaining_sessions = remaining_sessions - 1
      where id = selected_entitlement.id;
  else
    raise exception 'A free or single-session entitlement is required to book a session';
  end if;

  update public.therapist_availability set is_booked = true where id = slot.id;
  insert into public.appointments(
    availability_id, client_id, therapist_id, starts_at, ends_at, price_cents, entitlement_id
  )
  values (
    slot.id, auth.uid(), slot.therapist_id, slot.starts_at, slot.ends_at,
    case when selected_entitlement.kind = 'free_session' then 0 else 1000 end,
    selected_entitlement.id
  )
  returning id into appointment_id;
  return appointment_id;
end;
$$;

create or replace function public.get_my_appointments()
returns table (
  id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.appointment_status,
  therapist_name text,
  client_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.starts_at, a.ends_at, a.status,
    tp.full_name as therapist_name, cp.full_name as client_name
  from public.appointments a
  join public.profiles cp on cp.id = a.client_id
  join public.therapists tp on tp.id = a.therapist_id
  where auth.uid() = a.client_id or auth.uid() = a.therapist_id
     or public.is_admin()
  order by a.starts_at;
$$;

create or replace function public.activate_paid_entitlement(
  p_payment_id uuid,
  p_provider_session_id text,
  p_provider_payment_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  paid_record public.payments%rowtype;
  entitlement_expiry timestamptz;
  session_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into paid_record from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment record not found'; end if;
  if paid_record.status = 'successful' then return; end if;
  if paid_record.status <> 'pending' then raise exception 'Payment is not pending'; end if;
  if paid_record.provider_session_id is null or paid_record.provider_session_id <> p_provider_session_id then
    raise exception 'Payment session does not match the recorded checkout';
  end if;

  if paid_record.package = 'weekly_access' then entitlement_expiry := now() + interval '7 days';
  elsif paid_record.package = 'monthly_access' then entitlement_expiry := now() + interval '30 days';
  else entitlement_expiry := null;
  end if;
  session_count := case when paid_record.package = 'single_session' then 1 else null end;

  update public.payments
    set status = 'successful', provider_payment_id = p_provider_payment_id, updated_at = now()
    where id = paid_record.id;
  insert into public.client_entitlements(
    client_id, kind, remaining_sessions, expires_at, source_payment_id
  )
  values (
    paid_record.client_id, paid_record.package, session_count, entitlement_expiry, paid_record.id
  )
  on conflict (source_payment_id) do nothing;
end;
$$;

alter table public.profiles enable row level security;
alter table public.therapists enable row level security;
alter table public.agreement_acceptances enable row level security;
alter table public.payments enable row level security;
alter table public.client_entitlements enable row level security;
alter table public.therapist_availability enable row level security;
alter table public.appointments enable row level security;
alter table public.reviews enable row level security;
alter table public.notifications enable row level security;
alter table public.admin_activity enable row level security;

create policy "Profiles are visible to their owner and admins" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "Profiles can be updated by their owner" on public.profiles
  for update using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

create policy "Therapist profiles are visible when eligible" on public.therapists
  for select using (
    (verification_status = 'approved' and public.can_browse_therapists())
    or id = auth.uid()
    or public.is_admin()
  );
create policy "Therapists can create their own profile" on public.therapists
  for insert with check (
    id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'therapist')
  );
create policy "Therapists and admins can update profiles" on public.therapists
  for update using (
    id = auth.uid()
    or public.is_admin()
  ) with check (
    id = auth.uid()
    or public.is_admin()
  );

create policy "Users can view their agreement history" on public.agreement_acceptances
  for select using (user_id = auth.uid() or public.is_admin());
create policy "Clients can view their payment history" on public.payments
  for select using (client_id = auth.uid() or public.is_admin());
create policy "Entitlements are visible to their owner and admins" on public.client_entitlements
  for select using (client_id = auth.uid() or public.is_admin());

create policy "Availability is visible to eligible clients and its therapist" on public.therapist_availability
  for select using (
    (public.can_browse_therapists() and exists (
      select 1 from public.therapists t where t.id = therapist_id and t.verification_status = 'approved'
    ))
    or therapist_id = auth.uid()
    or public.is_admin()
  );
create policy "Therapists manage their own availability" on public.therapist_availability
  for insert with check (therapist_id = auth.uid() and starts_at > now());
create policy "Therapists update their own availability" on public.therapist_availability
  for update using (therapist_id = auth.uid() and not is_booked)
  with check (therapist_id = auth.uid() and not is_booked and starts_at > now());

create policy "Appointment participants and admins can view appointments" on public.appointments
  for select using (
    client_id = auth.uid() or therapist_id = auth.uid()
    or public.is_admin()
  );

create policy "Published reviews are public and clients see their own" on public.reviews
  for select using (published or client_id = auth.uid() or public.is_admin());
create policy "Clients can review completed sessions" on public.reviews
  for insert with check (
    client_id = auth.uid()
    and exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.client_id = auth.uid()
        and a.therapist_id = therapist_id and a.status = 'completed'
    )
  );

create policy "Users can view and update their notifications" on public.notifications
  for select using (user_id = auth.uid());
create policy "Users can update their own notifications" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Admins can view activity" on public.admin_activity
  for select using (public.is_admin());

create or replace function public.audit_therapist_verification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.verification_status is distinct from new.verification_status and public.is_admin() then
    insert into public.admin_activity(admin_id, action, subject_type, subject_id, details)
    values (
      auth.uid(),
      'therapist_verification_changed',
      'therapist',
      new.id,
      jsonb_build_object('from', old.verification_status, 'to', new.verification_status)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_therapist_verification on public.therapists;
create trigger audit_therapist_verification
  after update of verification_status on public.therapists
  for each row execute procedure public.audit_therapist_verification();

revoke all on function public.activate_paid_entitlement(uuid, text, text) from public, anon, authenticated;
grant execute on function public.activate_paid_entitlement(uuid, text, text) to service_role;
revoke all on function public.complete_onboarding(text) from public, anon;
revoke all on function public.get_client_access() from public, anon;
revoke all on function public.book_appointment(uuid) from public, anon;
revoke all on function public.get_my_appointments() from public, anon;
revoke all on function public.can_browse_therapists() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.complete_onboarding(text) to authenticated;
grant execute on function public.get_client_access() to authenticated;
grant execute on function public.book_appointment(uuid) to authenticated;
grant execute on function public.get_my_appointments() to authenticated;
grant execute on function public.can_browse_therapists() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_admin() to service_role;
