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
 select m.user_id, u.email, m.nickname, m.role,
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
   allowance - (select count(*) from public.votes v where v.season_id=p_season and v.user_id=m.user_id and v.choice='SUPER_LIKE'
     and exists (select 1 from public.season_tracks st where st.season_id=p_season and st.track_id=v.track_id and st.active))
 from public.season_members m join auth.users u on u.id=m.user_id
 where m.season_id=p_season order by m.joined_at,m.user_id;
end $$;
grant execute on function public.admin_members(uuid) to authenticated;
