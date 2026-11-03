-- Season-scoped member/invitation operations for the expanded admin panel.
-- Season creation remains owner-operated and is intentionally unchanged.
create table private.season_membership_events (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons on delete restrict,
  actor_id uuid not null references auth.users on delete restrict,
  member_id uuid not null references auth.users on delete restrict,
  old_role text not null check (old_role in ('member','admin')),
  new_role text not null check (new_role in ('member','admin')),
  changed_at timestamptz not null default clock_timestamp(),
  check (old_role <> new_role)
);
create index season_membership_events_season on private.season_membership_events(season_id, changed_at);
alter table private.season_membership_events enable row level security;
revoke all on table private.season_membership_events from public, anon, authenticated;
create trigger season_membership_events_immutable before update or delete or truncate
 on private.season_membership_events for each statement execute function private.immutable_event();

create function public.admin_members(p_season uuid)
returns table(user_id uuid, email text, nickname text, role text, active_tracks bigint,
  rated bigint, unrated bigint, completion_percent numeric, super_likes_used bigint,
  super_likes_available integer)
language plpgsql stable security definer set search_path = '' as $$
begin
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 return query
 select m.user_id, u.email, m.nickname, m.role, c.total,
   count(v.track_id), c.total-count(v.track_id),
   case when c.total=0 then null else round(100.0*count(v.track_id)/c.total,2) end,
   count(v.track_id) filter (where v.choice='SUPER_LIKE'),
   (s.super_like_allowance-count(v.track_id) filter (where v.choice='SUPER_LIKE'))::integer
 from public.season_members m
 join auth.users u on u.id=m.user_id
 join public.seasons s on s.id=m.season_id
 cross join lateral (select count(*)::bigint as total from public.season_tracks st
   where st.season_id=p_season and st.active) c
 left join public.votes v on v.season_id=p_season and v.user_id=m.user_id
   and exists (select 1 from public.season_tracks st where st.season_id=p_season and st.track_id=v.track_id and st.active)
 where m.season_id=p_season
 group by m.user_id,u.email,m.nickname,m.role,c.total,s.super_like_allowance
 order by m.joined_at,m.user_id;
end $$;

create function public.admin_invitations(p_season uuid)
returns table(id uuid, email text, created_at timestamptz, accepted_by uuid, accepted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 return query select i.id,i.email,i.created_at,i.accepted_by,i.accepted_at
 from public.season_invitations i where i.season_id=p_season order by i.created_at desc;
end $$;

create function public.set_member_role(p_season uuid,p_user uuid,p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; s public.seasons; current_role text; admins bigint; changed timestamptz;
begin
 actor:=private.require_user();
 if p_season is null or p_user is null or p_role not in ('member','admin') then
  raise exception using errcode='22023', message='invalid_member_role_payload';
 end if;
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 s:=private.lock_admin_season(p_season);
 select role into current_role from public.season_members where season_id=p_season and user_id=p_user for update;
 if current_role is null then raise exception using errcode='P0001', message='season_membership_required'; end if;
 if current_role=p_role then return jsonb_build_object('seasonId',p_season,'userId',p_user,'role',p_role,'changed',false); end if;
 if current_role='admin' and p_role='member' then
  select count(*) into admins from public.season_members where season_id=p_season and role='admin';
  if admins<=1 then raise exception using errcode='P0001', message='last_admin_required'; end if;
 end if;
 changed:=clock_timestamp();
 update public.season_members set role=p_role where season_id=p_season and user_id=p_user;
 insert into private.season_membership_events(season_id,actor_id,member_id,old_role,new_role,changed_at)
 values(p_season,actor,p_user,current_role,p_role,changed);
 return jsonb_build_object('seasonId',p_season,'userId',p_user,'role',p_role,'changed',true,'changedAt',changed);
end $$;

revoke all on function public.admin_members(uuid), public.admin_invitations(uuid), public.set_member_role(uuid,uuid,text)
 from public, anon, authenticated;
grant execute on function public.admin_members(uuid), public.admin_invitations(uuid), public.set_member_role(uuid,uuid,text)
 to authenticated;
