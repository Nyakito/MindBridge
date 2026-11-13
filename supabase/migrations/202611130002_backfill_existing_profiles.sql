insert into public.profiles (id, role, full_name)
select
  u.id,
  case
    when u.raw_user_meta_data ->> 'account_type' = 'therapist' then 'therapist'::public.user_role
    else 'client'::public.user_role
  end,
  coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), '')
from auth.users u
on conflict (id) do nothing;

insert into public.therapists (id, full_name)
select p.id, p.full_name
from public.profiles p
where p.role = 'therapist'
on conflict (id) do nothing;
