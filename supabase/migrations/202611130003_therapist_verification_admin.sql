create table if not exists public.therapist_verifications (
  therapist_id uuid primary key references public.therapists(id) on delete cascade,
  legal_name text not null,
  registration_number text not null,
  issuing_jurisdiction text not null,
  registration_expiry date not null,
  qualification_details text not null,
  registration_status text not null default 'active' check (registration_status in ('active', 'pending', 'expired', 'not_applicable')),
  credential_paths text[] not null default '{}',
  status public.verification_status not null default 'pending',
  rejection_reason text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  check (char_length(trim(legal_name)) >= 2),
  check (char_length(trim(registration_number)) >= 2),
  check (char_length(trim(issuing_jurisdiction)) >= 2),
  check (char_length(trim(qualification_details)) >= 10)
);

create index if not exists therapist_verifications_review_idx
  on public.therapist_verifications(status, submitted_at);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null check (category in ('booking', 'payment', 'therapist_concern', 'account', 'technical', 'other')),
  subject text not null check (char_length(trim(subject)) between 4 and 160),
  message text not null check (char_length(trim(message)) between 10 and 4000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_tickets drop column if exists admin_notes;

create index if not exists support_tickets_status_idx
  on public.support_tickets(status, created_at desc);

create table if not exists public.support_ticket_notes (
  ticket_id uuid primary key references public.support_tickets(id) on delete cascade,
  admin_id uuid not null references public.profiles(id),
  note text not null check (char_length(trim(note)) between 1 and 4000),
  updated_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'therapist-credentials',
  'therapist-credentials',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'therapist-avatars',
  'therapist-avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.therapist_verifications enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_ticket_notes enable row level security;

create policy "Therapists and admins can read verification applications"
  on public.therapist_verifications for select
  using (therapist_id = auth.uid() or public.is_admin());

create policy "Therapists can submit their verification application"
  on public.therapist_verifications for insert
  with check (
    therapist_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'therapist')
  );

create policy "Therapists can update their own verification details"
  on public.therapist_verifications for update
  using (therapist_id = auth.uid())
  with check (therapist_id = auth.uid());

create policy "Users can view their support tickets and admins can view all"
  on public.support_tickets for select
  using (user_id = auth.uid() or public.is_admin());

create policy "Users can create their own support tickets"
  on public.support_tickets for insert
  with check (user_id = auth.uid());

create policy "Admins can manage support tickets"
  on public.support_tickets for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "Only admins can view internal support notes"
  on public.support_ticket_notes for select
  using (public.is_admin());

create policy "Only admins can create internal support notes"
  on public.support_ticket_notes for insert
  with check (public.is_admin() and admin_id = auth.uid());

create policy "Only admins can update internal support notes"
  on public.support_ticket_notes for update
  using (public.is_admin())
  with check (public.is_admin() and admin_id = auth.uid());

create policy "Admins can moderate reviews"
  on public.reviews for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "Therapists can respond to reviews"
  on public.reviews for update
  using (therapist_id = auth.uid())
  with check (therapist_id = auth.uid());

create policy "Applicants can upload their credential documents"
  on storage.objects for insert
  with check (
    bucket_id = 'therapist-credentials'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'therapist')
  );

create policy "Applicants and admins can read credential documents"
  on storage.objects for select
  using (
    bucket_id = 'therapist-credentials'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

create policy "Applicants can remove their own credential documents"
  on storage.objects for delete
  using (
    bucket_id = 'therapist-credentials'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Therapists can upload their own profile photos"
  on storage.objects for insert
  with check (
    bucket_id = 'therapist-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'therapist')
  );

create policy "Therapists can replace their own profile photos"
  on storage.objects for update
  using (
    bucket_id = 'therapist-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'therapist-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create or replace function public.protect_therapist_verification_application()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() = new.therapist_id and not public.is_admin() then
    if tg_op = 'INSERT' then
      new.status := 'pending';
      new.rejection_reason := null;
      new.reviewed_at := null;
      new.reviewed_by := null;
    else
      new.status := old.status;
      new.rejection_reason := old.rejection_reason;
      new.reviewed_at := old.reviewed_at;
      new.reviewed_by := old.reviewed_by;
      if old.status = 'rejected'
        or new.legal_name is distinct from old.legal_name
        or new.registration_number is distinct from old.registration_number
        or new.issuing_jurisdiction is distinct from old.issuing_jurisdiction
        or new.registration_expiry is distinct from old.registration_expiry
        or new.registration_status is distinct from old.registration_status
        or new.qualification_details is distinct from old.qualification_details
        or new.credential_paths is distinct from old.credential_paths then
        new.status := 'pending';
        new.rejection_reason := null;
        new.reviewed_at := null;
        new.reviewed_by := null;
      end if;
    end if;
    new.submitted_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_therapist_verification_application on public.therapist_verifications;
create trigger protect_therapist_verification_application
  before insert or update on public.therapist_verifications
  for each row execute procedure public.protect_therapist_verification_application();

drop trigger if exists audit_therapist_verification on public.therapists;

create or replace function public.sync_therapist_verification_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    perform set_config('mindbridge.allow_verification_sync', 'true', true);
    update public.therapists
    set verification_status = new.status
    where id = new.therapist_id;
    perform set_config('mindbridge.allow_verification_sync', 'false', true);
  end if;
  return new;
end;
$$;

drop trigger if exists sync_therapist_verification_status on public.therapist_verifications;
create trigger sync_therapist_verification_status
  after insert or update on public.therapist_verifications
  for each row execute procedure public.sync_therapist_verification_status();

create or replace function public.protect_therapist_verification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() = old.id
     and coalesce(current_setting('role', true), '') <> 'service_role'
     and coalesce(current_setting('mindbridge.allow_verification_sync', true), '') <> 'true'
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

create or replace function public.protect_review_updates()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  if auth.uid() = old.therapist_id then
    if new.id <> old.id
      or new.appointment_id <> old.appointment_id
      or new.client_id <> old.client_id
      or new.therapist_id <> old.therapist_id
      or new.rating <> old.rating
      or new.body <> old.body
      or new.published <> old.published
      or new.created_at <> old.created_at then
      raise exception 'Therapists may only respond to a review';
    end if;
    return new;
  end if;
  raise exception 'Review update not authorized';
end;
$$;

drop trigger if exists protect_review_updates on public.reviews;
create trigger protect_review_updates
  before update on public.reviews
  for each row execute procedure public.protect_review_updates();

create or replace function public.review_therapist_application(
  p_therapist_id uuid,
  p_decision text,
  p_rejection_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  application public.therapist_verifications%rowtype;
  decision_status public.verification_status;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'Choose approve or reject';
  end if;
  if p_decision = 'rejected' and char_length(trim(coalesce(p_rejection_reason, ''))) < 8 then
    raise exception 'Provide a clear rejection reason of at least 8 characters';
  end if;

  select * into application from public.therapist_verifications
  where therapist_id = p_therapist_id
  for update;
  if not found then raise exception 'Therapist verification application not found'; end if;
  if application.status not in ('pending', 'under_review') then
    raise exception 'This application is no longer awaiting review';
  end if;
  if p_decision = 'approved' then
    if application.registration_status <> 'active'
      or application.registration_expiry <= current_date
      or cardinality(application.credential_paths) = 0
      or char_length(trim(application.qualification_details)) < 10
      or exists (
        select 1
        from unnest(application.credential_paths) as credential(path)
        where credential.path not like p_therapist_id::text || '/%'
          or not exists (
            select 1 from storage.objects stored_file
            where stored_file.bucket_id = 'therapist-credentials'
              and stored_file.name = credential.path
          )
      ) then
      raise exception 'Active registration, current expiry, qualifications, and credential documents are required';
    end if;
    decision_status := 'approved';
  else
    decision_status := 'rejected';
  end if;

  update public.therapist_verifications
  set status = decision_status,
      rejection_reason = case when decision_status = 'rejected' then trim(p_rejection_reason) else null end,
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      updated_at = now()
  where therapist_id = p_therapist_id;

  insert into public.admin_activity(admin_id, action, subject_type, subject_id, details)
  values (
    auth.uid(),
    case when decision_status = 'approved' then 'therapist_application_approved' else 'therapist_application_rejected' end,
    'therapist',
    p_therapist_id,
    jsonb_build_object('reason', case when decision_status = 'rejected' then trim(p_rejection_reason) else null end)
  );
end;
$$;

revoke all on function public.review_therapist_application(uuid, text, text) from public, anon;
grant execute on function public.review_therapist_application(uuid, text, text) to authenticated;
