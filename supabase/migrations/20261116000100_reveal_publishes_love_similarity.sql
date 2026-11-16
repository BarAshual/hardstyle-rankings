-- Product change: REVEAL is the single deliberate publish moment for the
-- approved love-similarity category. Preserve the old category tables/events
-- for historical auditability, but no longer use them as a second gate.

create or replace function public.get_love_similarity_visibility(p_season uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
 perform private.require_user();
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception using errcode='25000', message='read_committed_required';
 end if;
 perform set_config('response.headers', '[{"Cache-Control":"no-store"}]', true);
 select jsonb_build_object('seasonId', s.id, 'category', 'love_similarity',
  'visible', s.state = 'REVEAL', 'state', s.state, 'canChange', false)
 into result from public.seasons s where s.id=p_season;
 return result;
end $$;

create or replace function public.set_love_similarity_visibility(p_season uuid, p_visible boolean, p_action uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
 perform private.require_user();
 if p_season is null or p_visible is null or p_action is null then
  raise exception using errcode='22023', message='invalid_result_visibility_payload';
 end if;
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 raise exception using errcode='P0001', message='result_visibility_control_removed';
end $$;

create or replace function public.get_love_similarity_results(p_season uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare season_state text; result jsonb;
begin
 perform private.require_user();
 if not private.is_member(p_season) then
  raise exception using errcode='42501', message='season_membership_required';
 end if;
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception using errcode='25000', message='read_committed_required';
 end if;
 select state into season_state from public.seasons where id=p_season for update;
 if season_state is distinct from 'REVEAL' then
  raise exception using errcode='42501', message='results_not_available';
 end if;
 perform set_config('response.headers', '[{"Cache-Control":"no-store"}]', true);
 with eligible_votes as materialized (
  select v.user_id, v.track_id, v.choice from public.votes v
  join public.season_tracks st on st.season_id=v.season_id and st.track_id=v.track_id
  where v.season_id=p_season and st.active
 ), members as materialized (
  select user_id, nickname from public.season_members where season_id=p_season
 )
 select jsonb_build_object('seasonId', p_season, 'algorithm', 'taste-love-v1',
  'pairs', coalesce(jsonb_agg(jsonb_build_object(
   'first', jsonb_build_object('memberId', a.user_id, 'nickname', a.nickname),
   'second', jsonb_build_object('memberId', b.user_id, 'nickname', b.nickname),
   'coRatedCount', counts.co_rated,
   'loveIntersectionCount', counts.love_intersection,
   'loveUnionCount', counts.love_union,
   'slIntersectionCount', counts.sl_intersection,
   'slUnionCount', counts.sl_union
  ) order by a.user_id, b.user_id), '[]'::jsonb)) into result
 from members a join members b on a.user_id < b.user_id
 cross join lateral (
  select count(*) as co_rated,
   count(*) filter (where va.choice in ('LIKE','SUPER_LIKE') and vb.choice in ('LIKE','SUPER_LIKE')) as love_intersection,
   count(*) filter (where va.choice in ('LIKE','SUPER_LIKE') or vb.choice in ('LIKE','SUPER_LIKE')) as love_union,
   count(*) filter (where va.choice='SUPER_LIKE' and vb.choice='SUPER_LIKE') as sl_intersection,
   count(*) filter (where va.choice='SUPER_LIKE' or vb.choice='SUPER_LIKE') as sl_union
  from eligible_votes va join eligible_votes vb on vb.track_id=va.track_id
  where va.user_id=a.user_id and vb.user_id=b.user_id
 ) counts;
 return result;
end $$;

grant execute on function public.get_love_similarity_visibility(uuid),
 public.set_love_similarity_visibility(uuid,boolean,uuid),
 public.get_love_similarity_results(uuid) to authenticated;
