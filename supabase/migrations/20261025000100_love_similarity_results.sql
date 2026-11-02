-- D49-D52: explicit category opening after REVEAL, independent of lifecycle.
-- Engineering/API plan: docs/wrapped-results-server.md (recorded first).
create table private.season_result_categories (
 season_id uuid not null references public.seasons on delete restrict,
 category text not null check (category = 'love_similarity'),
 visible boolean not null default false,
 primary key (season_id, category)
);
create table private.season_result_category_events (
 actor_id uuid not null,
 action_id uuid not null,
 season_id uuid not null,
 category text not null check (category = 'love_similarity'),
 old_visible boolean not null,
 new_visible boolean not null,
 changed_at timestamptz not null default clock_timestamp(),
 primary key (actor_id, action_id),
 foreign key (season_id, actor_id) references public.season_members on delete restrict,
 foreign key (season_id, category) references private.season_result_categories on delete restrict
);
create index season_result_category_events_season
 on private.season_result_category_events(season_id, changed_at);
create trigger result_category_events_immutable before update or delete or truncate
 on private.season_result_category_events for each statement
 execute function private.immutable_event();
alter table private.season_result_categories enable row level security;
alter table private.season_result_category_events enable row level security;
revoke all on table private.season_result_categories, private.season_result_category_events
 from public, anon, authenticated;

-- Operational metadata only: usable by the planned admin panel in every state.
create function public.get_love_similarity_visibility(p_season uuid) returns jsonb
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
  'visible', coalesce(c.visible, false), 'state', s.state, 'canChange', s.state='REVEAL')
 into result from public.seasons s
 left join private.season_result_categories c on c.season_id=s.id and c.category='love_similarity'
 where s.id=p_season;
 return result;
end $$;

create function public.set_love_similarity_visibility(p_season uuid, p_visible boolean, p_action uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; s public.seasons; e private.season_result_category_events; previous boolean;
begin
 actor := private.require_user();
 if p_season is null or p_visible is null or p_action is null then
  raise exception using errcode='22023', message='invalid_result_visibility_payload';
 end if;
 if not private.is_admin(p_season) then
  raise exception using errcode='42501', message='season_admin_required';
 end if;
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception using errcode='25000', message='read_committed_required';
 end if;
 -- Same actor-before-season order as voting; serialize this actor's action IDs
 -- across seasons without changing the independent vote-action ledger.
 perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
 select * into e from private.season_result_category_events
 where actor_id=actor and action_id=p_action;
 if found then
  if e.season_id <> p_season or e.new_visible <> p_visible then
   raise exception using errcode='P0001', message='action_payload_conflict';
  end if;
 else
  s := private.lock_admin_season(p_season);
  if s.state <> 'REVEAL' then
   raise exception using errcode='P0001', message='results_require_reveal';
  end if;
  select coalesce((select visible from private.season_result_categories
   where season_id=p_season and category='love_similarity'), false) into previous;
  insert into private.season_result_categories(season_id, category, visible)
  values (p_season, 'love_similarity', p_visible)
  on conflict (season_id, category) do update set visible=excluded.visible;
  -- Record every accepted action, including same-value requests; exact retries
  -- return this receipt and never repeat the write after a later toggle.
  insert into private.season_result_category_events
   (actor_id, action_id, season_id, category, old_visible, new_visible)
  values (actor, p_action, p_season, 'love_similarity', previous, p_visible)
  returning * into e;
 end if;
 perform set_config('response.headers', '[{"Cache-Control":"no-store"}]', true);
 return jsonb_build_object('seasonId', e.season_id, 'category', e.category,
  'visible', e.new_visible, 'actionId', e.action_id, 'changedAt', e.changed_at);
end $$;

-- VOLATILE (the default) is deliberate: after waiting on the season lock,
-- subsequent statements must see newly committed lifecycle/visibility changes.
-- No formula coefficients here; the shared taste-love-v1 TypeScript helper
-- consumes only this evidence, never another member's ballot or audit history.
create function public.get_love_similarity_results(p_season uuid) returns jsonb
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
 if season_state is distinct from 'REVEAL' or not coalesce((
  select visible from private.season_result_categories
  where season_id=p_season and category='love_similarity'
 ), false) then
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

-- Explicitly scoped grants: existing votes/events/progress and schema defaults
-- are untouched. Private storage has no client policies or direct grants.
revoke all on function public.get_love_similarity_visibility(uuid),
 public.set_love_similarity_visibility(uuid,boolean,uuid),
 public.get_love_similarity_results(uuid) from public, anon, authenticated;
grant execute on function public.get_love_similarity_visibility(uuid),
 public.set_love_similarity_visibility(uuid,boolean,uuid),
 public.get_love_similarity_results(uuid) to authenticated;
