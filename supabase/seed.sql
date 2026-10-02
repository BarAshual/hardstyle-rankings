-- Local synthetic identities only: no real users, tokens, or credentials.
-- Never execute this seed in production. Integration tests exercise RPC admission.
insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'authenticated','authenticated','fixture'||n||'@example.invalid',
 case when n=5 then null else now() end,
 '{"provider":"google","providers":["google"]}'::jsonb,
 '{"email":"fixture2@example.invalid","email_verified":true}'::jsonb,now(),now()
from generate_series(1,5) n;
insert into auth.identities(id,user_id,provider_id,provider,identity_data,created_at,updated_at)
select gen_random_uuid(),id,id::text,'google',
 jsonb_build_object('sub',id::text,'email',email,'email_verified',id <> '00000000-0000-0000-0000-000000000005'::uuid),now(),now()
from auth.users where email like 'fixture%@example.invalid';
-- User 1 is the creator/admin. Users 2 and 3 are potential invitees; 4 is an outsider;
-- 5 has an unverified identity. Forged user_metadata deliberately claims user 2's email.
set role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"provider":"google"}}',false);
do $$
declare sid uuid;
begin
 sid:=public.create_season('Synthetic local demo',2026,2,'Fixture admin');
 perform public.add_track(sid,'Synthetic Track One',array['Synthetic Artist']);
 perform public.add_track(sid,'Synthetic Track Two',array['Synthetic Artist Two']);
end $$;
reset role;
reset request.jwt.claims;
