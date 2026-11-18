-- Additive closeout repairs; plan: docs/admin-closeout.md.
-- Preserve operational shapes, authorization, season locks and audit history.
create or replace function public.admin_members(p_season uuid)
returns table(user_id uuid, email text, nickname text, role text, active_tracks bigint,
  rated bigint, unrated bigint, completion_percent numeric, super_likes_used bigint,
  super_likes_available integer)
language plpgsql stable security definer set search_path = '' as $$
declare allowance integer;
begin
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 select s.super_like_allowance into allowance from public.seasons s where s.id=p_season;
 return query
 select m.user_id, u.email::text, m.nickname, m.role,
   (select count(*) from public.season_tracks st where st.season_id=p_season and st.active),
   (select count(*) from public.votes v where v.season_id=p_season and v.user_id=m.user_id
     and exists (select 1 from public.season_tracks st where st.season_id=p_season and st.track_id=v.track_id and st.active)),
   (select count(*) from public.season_tracks st where st.season_id=p_season and st.active)
     - (select count(*) from public.votes v where v.season_id=p_season and v.user_id=m.user_id
       and exists (select 1 from public.season_tracks st where st.season_id=p_season and st.track_id=v.track_id and st.active)),
   case when (select count(*) from public.season_tracks st where st.season_id=p_season and st.active)=0 then null
     else round(100.0*(select count(*) from public.votes v where v.season_id=p_season and v.user_id=m.user_id
       and exists (select 1 from public.season_tracks st where st.season_id=p_season and st.track_id=v.track_id and st.active)) /
       (select count(*) from public.season_tracks st where st.season_id=p_season and st.active),2) end,
   (select count(*) from public.votes v where v.season_id=p_season and v.user_id=m.user_id and v.choice='SUPER_LIKE'
     and exists (select 1 from public.season_tracks st where st.season_id=p_season and st.track_id=v.track_id and st.active)),
   (allowance - (select count(*) from public.votes v where v.season_id=p_season and v.user_id=m.user_id and v.choice='SUPER_LIKE'
     and exists (select 1 from public.season_tracks st where st.season_id=p_season and st.track_id=v.track_id and st.active)))::integer
 from public.season_members m join auth.users u on u.id=m.user_id
 where m.season_id=p_season order by m.joined_at,m.user_id;
end $$;
grant execute on function public.admin_members(uuid) to authenticated;

create or replace function public.set_member_role(p_season uuid,p_user uuid,p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; member_previous_role text; admins bigint; changed timestamptz;
begin
 actor:=private.require_user();
 if p_season is null or p_user is null or p_role is null or p_role not in ('member','admin') then
  raise exception using errcode='22023', message='invalid_member_role_payload';
 end if;
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 perform private.lock_admin_season(p_season);
 select role into member_previous_role from public.season_members where season_id=p_season and user_id=p_user for update;
 if member_previous_role is null then raise exception using errcode='P0001', message='season_membership_required'; end if;
 if member_previous_role=p_role then return jsonb_build_object('seasonId',p_season,'userId',p_user,'role',p_role,'changed',false); end if;
 if member_previous_role='admin' and p_role='member' then
  select count(*) into admins from public.season_members where season_id=p_season and role='admin';
  if admins<=1 then raise exception using errcode='P0001', message='last_admin_required'; end if;
 end if;
 changed:=clock_timestamp();
 update public.season_members set role=p_role where season_id=p_season and user_id=p_user;
 insert into private.season_membership_events(season_id,actor_id,member_id,old_role,new_role,changed_at)
 values(p_season,actor,p_user,member_previous_role,p_role,changed);
 return jsonb_build_object('seasonId',p_season,'userId',p_user,'role',p_role,'changed',true,'changedAt',changed);
end $$;
