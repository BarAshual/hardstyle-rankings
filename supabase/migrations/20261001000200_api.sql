-- Helpers are in a non-exposed schema, with explicit grants in the security migration.
create function private.is_member(p_season uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.season_members where season_id=p_season and user_id=auth.uid())
$$;
create function private.is_admin(p_season uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.season_members where season_id=p_season and user_id=auth.uid() and role='admin')
$$;
create function private.require_user() returns uuid language plpgsql stable set search_path = '' as $$
declare u uuid := auth.uid();
begin
 if u is null then raise exception using errcode='42501',message='authentication_required'; end if;
 return u;
end $$;
-- Provider-owned identity data is trusted; raw_user_meta_data and RPC email claims are not.
create function private.google_email() returns text language plpgsql stable security definer set search_path = '' as $$
declare result text;
begin
 perform private.require_user();
 select private.normalize_email(i.identity_data->>'email') into result
 from auth.identities i join auth.users u on u.id=i.user_id
 where i.user_id=auth.uid() and i.provider='google'
 and i.identity_data->'email_verified' = 'true'::jsonb
 and u.email_confirmed_at is not null
 and private.normalize_email(u.email)=private.normalize_email(i.identity_data->>'email');
 if result is null then raise exception using errcode='42501',message='verified_google_identity_required'; end if;
 return result;
end $$;
create function private.lock_admin_season(p_season uuid) returns public.seasons language plpgsql security definer set search_path = '' as $$
declare s public.seasons;
begin
 perform private.require_user();
 if not private.is_admin(p_season) then raise exception using errcode='42501',message='season_admin_required'; end if;
 select * into s from public.seasons where id=p_season for update;
 return s;
end $$;

create function public.create_season(p_name text,p_year integer,p_allowance integer,p_nickname text) returns uuid language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
 perform private.google_email();
 insert into public.seasons(name,year,super_like_allowance,created_by) values(p_name,p_year,p_allowance,auth.uid()) returning id into sid;
 insert into public.season_members(season_id,user_id,nickname,role) values(sid,auth.uid(),p_nickname,'admin');
 return sid;
end $$;
create function public.invite_member(p_season uuid,p_email text) returns uuid language plpgsql security definer set search_path = '' as $$
declare iid uuid;
begin
 perform private.lock_admin_season(p_season);
 insert into public.season_invitations(season_id,email,invited_by) values(p_season,private.normalize_email(p_email),auth.uid())
 on conflict(season_id,email) do nothing returning id into iid;
 if iid is null then select id into iid from public.season_invitations where season_id=p_season and email=private.normalize_email(p_email); end if;
 return iid;
end $$;
create function public.accept_invitation(p_invitation uuid,p_nickname text) returns uuid language plpgsql security definer set search_path = '' as $$
declare mail text; inv public.season_invitations; sid uuid;
begin
 mail := private.google_email();
 -- Read only to identify the lock; re-read after locking. Same generic error for unknown/wrong identities.
 select season_id into sid from public.season_invitations where id=p_invitation;
 if sid is null then raise exception using errcode='42501',message='invitation_not_available'; end if;
 perform 1 from public.seasons where id=sid for update;
 select * into inv from public.season_invitations where id=p_invitation;
 if inv.email <> mail or (inv.accepted_by is not null and inv.accepted_by <> auth.uid()) then
  raise exception using errcode='42501',message='invitation_not_available';
 end if;
 if inv.accepted_by=auth.uid() then return sid; end if;
 insert into public.season_members(season_id,user_id,nickname) values(sid,auth.uid(),p_nickname) on conflict do nothing;
 update public.season_invitations set accepted_by=auth.uid(),accepted_at=clock_timestamp() where id=p_invitation;
 return sid;
end $$;

-- A modest manual catalog input, not a provider import or deduplication system.
create function public.add_track(p_season uuid,p_title text,p_artists text[] default '{}') returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.seasons; tid uuid; aid uuid; artist_name text; pos integer:=0;
begin
 s:=private.lock_admin_season(p_season);
 if s.state not in ('SETUP','VOTING') then raise exception using errcode='P0001',message='catalog_closed'; end if;
 insert into public.tracks(title) values(p_title) returning id into tid;
 foreach artist_name in array p_artists loop
  insert into public.artists(name) values(artist_name) returning id into aid;
  insert into public.track_artists(track_id,artist_id,credit_order) values(tid,aid,pos);
  pos:=pos+1;
 end loop;
 insert into public.season_tracks(season_id,track_id,added_by) values(p_season,tid,auth.uid());
 return tid;
end $$;
create function public.add_existing_track(p_season uuid,p_track uuid) returns void language plpgsql security definer set search_path = '' as $$
declare s public.seasons;
begin
 s:=private.lock_admin_season(p_season);
 if s.state not in ('SETUP','VOTING') then raise exception using errcode='P0001',message='catalog_closed'; end if;
 -- A guessed UUID cannot be used to discover another private season's catalog.
 if not exists(select 1 from public.season_tracks st where st.track_id=p_track and private.is_member(st.season_id)) then
  raise exception using errcode='42501',message='track_not_available';
 end if;
 insert into public.season_tracks(season_id,track_id,added_by) values(p_season,p_track,auth.uid()) on conflict do nothing;
end $$;
create function public.transition_season(p_season uuid,p_state text) returns text language plpgsql security definer set search_path = '' as $$
declare s public.seasons;
begin
 s:=private.lock_admin_season(p_season);
 if p_state is null or not ((s.state,p_state) in (('SETUP','VOTING'),('VOTING','LOCKED'),('LOCKED','REVEAL'))) then
  raise exception using errcode='P0001',message='invalid_transition';
 end if;
 update public.seasons set state=p_state where id=p_season;
 insert into public.season_lifecycle_events(season_id,actor_id,old_state,new_state) values(p_season,auth.uid(),s.state,p_state);
 return p_state;
end $$;
create function public.increase_allowance(p_season uuid,p_allowance integer,p_reason text) returns integer language plpgsql security definer set search_path = '' as $$
declare s public.seasons;
begin
 s:=private.lock_admin_season(p_season);
 if s.state <> 'VOTING' then raise exception using errcode='P0001',message='voting_closed'; end if;
 if p_allowance is null or p_allowance <= s.super_like_allowance then raise exception using errcode='P0001',message='allowance_must_increase'; end if;
 insert into public.season_config_events(season_id,actor_id,old_allowance,new_allowance,reason) values(p_season,auth.uid(),s.super_like_allowance,p_allowance,p_reason);
 update public.seasons set super_like_allowance=p_allowance where id=p_season;
 return p_allowance;
end $$;

create function public.cast_vote(p_season uuid,p_track uuid,p_choice text,p_expected_version integer,p_action uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid; s public.seasons; v public.votes; e public.vote_events; used bigint; stamp timestamptz;
begin
 u:=private.require_user();
 -- Counting after a blocking lock requires fresh statement snapshots.
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception using errcode='25000',message='read_committed_required';
 end if;
 if p_action is null or p_season is null or p_track is null or p_choice is null or p_choice not in ('PASS','LIKE','SUPER_LIKE') or p_expected_version is null or p_expected_version < 0 then
  raise exception using errcode='22023',message='invalid_vote_payload';
 end if;
 -- Serializes actor-global UUID use, including retries targeting different seasons.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,0));
 select * into e from public.vote_events where user_id=u and action_id=p_action;
 if found then
  if e.season_id<>p_season or e.track_id<>p_track or e.choice<>p_choice or e.expected_version<>p_expected_version then
   raise exception using errcode='P0001',message='action_payload_conflict';
  end if;
  return jsonb_build_object('action_id',e.action_id,'season_id',e.season_id,'track_id',e.track_id,'choice',e.choice,'version',e.version,'accepted_at',e.accepted_at);
 end if;
 if not private.is_member(p_season) then raise exception using errcode='42501',message='season_membership_required'; end if;
 select * into s from public.seasons where id=p_season for update;
 if s.state <> 'VOTING' then raise exception using errcode='P0001',message='voting_closed'; end if;
 if not exists(select 1 from public.season_tracks where season_id=p_season and track_id=p_track and active) then
  raise exception using errcode='P0001',message='track_not_active';
 end if;
 select * into v from public.votes where season_id=p_season and user_id=u and track_id=p_track;
 if coalesce(v.version,0)<>p_expected_version then raise exception using errcode='P0001',message='vote_version_conflict'; end if;
 if p_choice='SUPER_LIKE' and v.choice is distinct from 'SUPER_LIKE' then
  select count(*) into used from public.votes where season_id=p_season and user_id=u and choice='SUPER_LIKE';
  if used >= s.super_like_allowance then raise exception using errcode='P0001',message='super_like_limit'; end if;
 end if;
 stamp:=clock_timestamp();
 insert into public.votes(season_id,user_id,track_id,choice,version,updated_at) values(p_season,u,p_track,p_choice,p_expected_version+1,stamp)
 on conflict(season_id,user_id,track_id) do update set choice=excluded.choice,version=excluded.version,updated_at=excluded.updated_at;
 insert into public.vote_events(user_id,action_id,season_id,track_id,expected_version,version,previous_choice,choice,accepted_at)
 values(u,p_action,p_season,p_track,p_expected_version,p_expected_version+1,v.choice,p_choice,stamp);
 return jsonb_build_object('action_id',p_action,'season_id',p_season,'track_id',p_track,'choice',p_choice,'version',p_expected_version+1,'accepted_at',stamp);
end $$;

create function public.my_progress(p_season uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare total bigint; rated bigint; used bigint; allowance integer;
begin
 if not private.is_member(p_season) then raise exception using errcode='42501',message='season_membership_required'; end if;
 select count(*),count(v.track_id) into total,rated
 from public.season_tracks st left join public.votes v on v.season_id=st.season_id and v.track_id=st.track_id and v.user_id=auth.uid()
 where st.season_id=p_season and st.active;
 select count(*) into used from public.votes where season_id=p_season and user_id=auth.uid() and choice='SUPER_LIKE';
 select super_like_allowance into allowance from public.seasons where id=p_season;
 return jsonb_build_object('active_tracks',total,'rated',rated,'unrated',total-rated,'super_likes_used',used,'super_likes_available',allowance-used,'completion_percent',case when total=0 then null else round(100.0*rated/total,2) end);
end $$;
create function public.admin_progress(p_season uuid)
returns table(user_id uuid,nickname text,role text,active_tracks bigint,rated bigint,unrated bigint,completion_percent numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
 if not private.is_admin(p_season) then raise exception using errcode='42501',message='season_admin_required'; end if;
 return query
 select m.user_id,m.nickname,m.role,c.total,count(v.track_id),c.total-count(v.track_id),case when c.total=0 then null else round(100.0*count(v.track_id)/c.total,2) end
 from public.season_members m
 cross join (select count(*) total from public.season_tracks where season_id=p_season and active) c
 left join public.votes v on v.season_id=m.season_id and v.user_id=m.user_id
 and exists(select 1 from public.season_tracks st where st.season_id=v.season_id and st.track_id=v.track_id and st.active)
 where m.season_id=p_season group by m.user_id,m.nickname,m.role,c.total;
end $$;
