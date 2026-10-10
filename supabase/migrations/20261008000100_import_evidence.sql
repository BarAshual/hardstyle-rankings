-- Additive correction: 20261007000100 has already been applied locally.
-- Keep current provider observations distinct from retained accepted match evidence.
alter table private.track_providers add column accepted_isrcs text[] not null default '{}'::text[];
create index track_providers_accepted_isrcs on private.track_providers using gin(accepted_isrcs);

create function private.import_title_key(p_title text) returns text
language sql immutable strict set search_path='' as $$
 select lower(btrim(regexp_replace(p_title,'[[:space:]]+',' ','g')))
$$;
-- Index only importer staging; avoid repeated scans/normalization for large plans.
create index import_items_title_evidence on private.import_items(run_id,(private.import_title_key(candidate->>'title')))
 where candidate->>'kind'='track';
create index import_items_isrc_evidence on private.import_items(run_id,(candidate->>'isrc'))
 where candidate->>'kind'='track';
create function private.import_optional_baseline(p_identity jsonb,c jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare result jsonb:=p_identity;
begin
 if result->>'isrc' is null and c->>'isrc' ~ '^[A-Za-z0-9]{12}$' then
  result:=jsonb_set(result,'{isrc}',c->'isrc');
 end if;
 if result->>'duration_ms' is null and c->>'duration_ms' ~ '^[0-9]{1,8}$'
 and (c->>'duration_ms')::bigint between 1 and 86399999 then
  result:=jsonb_set(result,'{duration_ms}',c->'duration_ms');
 end if;
 return result;
end $$;
create function private.import_retained_isrcs(p_existing text[],c jsonb) returns text[]
language sql immutable set search_path='' as $$
 select coalesce(array_agg(distinct v order by v),'{}'::text[])
 from unnest(coalesce(p_existing,'{}'::text[])||array[c->>'isrc']) t(v)
 where v ~ '^[A-Za-z0-9]{12}$'
$$;

-- Only successful item receipts constitute admitted historical observations.
-- Backfill retention without changing canonical IDs, mappings, or plan/review history.
update private.track_providers p set accepted_isrcs=(
 select coalesce(array_agg(distinct v order by v),'{}'::text[]) from (
  select p.identity->>'isrc' v union all select p.observation->>'isrc'
  union all select i.candidate->>'isrc' from private.import_items i
   where i.receipt->>'track_id'=p.track_id::text and i.candidate->>'id'=p.provider_id
   and p.provider='spotify' and i.candidate->>'kind'='track'
 ) evidence where v ~ '^[A-Za-z0-9]{12}$'
);
-- An existing accepted baseline wins. Recover missing optional baselines from
-- unambiguous durable receipts, then the latest validated accepted observation.
update private.track_providers p set identity=private.import_optional_baseline(
 private.import_optional_baseline(p.identity,jsonb_build_object(
  'isrc',(select min(i.candidate->>'isrc') from private.import_items i
   where p.provider='spotify' and i.receipt->>'track_id'=p.track_id::text and i.candidate->>'id'=p.provider_id
   and i.candidate->>'isrc' ~ '^[A-Za-z0-9]{12}$' having count(distinct i.candidate->>'isrc')=1),
  'duration_ms',(select min((i.candidate->>'duration_ms')::bigint) from private.import_items i
   where p.provider='spotify' and i.receipt->>'track_id'=p.track_id::text and i.candidate->>'id'=p.provider_id
   and i.candidate->>'duration_ms' ~ '^[0-9]{1,8}$' having count(distinct i.candidate->>'duration_ms')=1)
 )),p.observation);

-- Catalog-only material evidence also accompanies new-item receipts, so a peer
-- exemption cannot hide metadata changes made after that peer was admitted.
create function private.import_catalog_evidence(p_track uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',t.id,'title',t.title,
  'providers',(select coalesce(jsonb_agg(jsonb_build_object('provider',p.provider,'id',p.provider_id,'identity',p.identity,'accepted_isrcs',p.accepted_isrcs) order by p.provider,p.provider_id),'[]'::jsonb) from private.track_providers p where p.track_id=t.id),
  'artists',(select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by ta.credit_order) from public.track_artists ta join public.artists a on a.id=ta.artist_id where ta.track_id=t.id))
 from public.tracks t where t.id=p_track
$$;

create or replace function private.import_candidate(c jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare a jsonb; allowed text[]:=array['id','title','artists','duration_ms','isrc','release_date','release_precision','album','artwork','url','available','original_id','kind'];
begin
 if jsonb_typeof(c)<>'object' or exists(select 1 from jsonb_object_keys(c) k where not(k=any(allowed))) or length(c::text)>16000 then raise exception 'invalid_candidate' using errcode='22023'; end if;
 if c->>'kind' in ('skipped','removed','invalid') then return c; end if;
 if c->>'kind' is distinct from 'track' or coalesce(c->>'id','') !~ '^[A-Za-z0-9]{22}$' or length(btrim(coalesce(c->>'title',''))) not between 1 and 500 or jsonb_typeof(c->'artists') is distinct from 'array' or jsonb_array_length(c->'artists') not between 1 and 30 then raise exception 'invalid_candidate' using errcode='22023'; end if;
 if c->'duration_ms' is not null and c->'duration_ms'<>'null'::jsonb and (jsonb_typeof(c->'duration_ms')<>'number' or (c->>'duration_ms') !~ '^[0-9]{1,8}$') then raise exception 'invalid_candidate' using errcode='22023'; end if;
 if c->>'isrc' is not null and (jsonb_typeof(c->'isrc')<>'string' or c->>'isrc' !~ '^[A-Za-z0-9]{12}$') then raise exception 'invalid_candidate' using errcode='22023'; end if;
 if c->>'duration_ms' is not null and (c->>'duration_ms')::bigint not between 1 and 86399999 then raise exception 'invalid_candidate' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(c->'artists') loop
  if coalesce(a->>'id','') !~ '^[A-Za-z0-9]{22}$' or length(btrim(coalesce(a->>'name',''))) not between 1 and 300 or exists(select 1 from jsonb_object_keys(a) k where k not in ('id','name')) then raise exception 'invalid_candidate' using errcode='22023'; end if;
 end loop;
 if c->>'url' is distinct from 'https://open.spotify.com/track/'||(c->>'id') or (c->>'artwork' is not null and c->>'artwork' !~ '^https://i\.scdn\.co/image/[A-Za-z0-9]+$') then raise exception 'invalid_candidate_url' using errcode='22023'; end if;
 return c;
end $$;
create or replace function private.import_evidence(p_season uuid,c jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare reasons jsonb:='[]'::jsonb; matches jsonb:='[]'::jsonb; m private.track_providers; yr integer; a jsonb; known boolean;
begin
 if c->>'kind'<>'track' then return jsonb_build_object('evidence_version',2,'same_run_peers','[]'::jsonb,'reasons',jsonb_build_array(c->>'kind'),'matches','[]'::jsonb,'identity',private.import_identity(c),'release_date',c->'release_date','release_precision',c->'release_precision'); end if;
 select year into yr from public.seasons where id=p_season;
 if c->>'release_date' ~ '^[0-9]{4}(-[0-9]{2}){0,2}$' then
  if left(c->>'release_date',4)::integer<>yr then reasons:=reasons||'"release_year"'::jsonb; end if;
 else reasons:=reasons||'"unknown_release_date"'::jsonb; end if;
 select * into m from private.track_providers where provider='spotify' and provider_id=c->>'id'; known:=found;
 if known then
  if m.identity->'title' is distinct from c->'title' or m.identity->'artists' is distinct from private.import_identity(c)->'artists'
   or (m.identity->>'isrc' is not null and c->>'isrc' is not null and m.identity->>'isrc'<>c->>'isrc')
   or (m.identity->>'duration_ms' is not null and c->>'duration_ms' is not null and abs((m.identity->>'duration_ms')::bigint-(c->>'duration_ms')::bigint)>2000) then reasons:=reasons||'"material_identity_conflict"'::jsonb; end if;
 else
  -- Only catalog evidence, including invisible catalog candidates; no vote queries.
  select coalesce(jsonb_agg(distinct t.id order by t.id),'[]') into matches from public.tracks t
  left join private.track_providers p on p.track_id=t.id
  where (c->>'isrc' is not null and p.accepted_isrcs @> array[c->>'isrc'])
   or private.import_title_key(t.title)=private.import_title_key(c->>'title')
   or (c->>'original_id' is not null and p.provider='spotify' and p.provider_id=c->>'original_id');
  if jsonb_array_length(matches)>0 then reasons:=reasons||'"suspected_match"'::jsonb; end if;
  for a in select value from jsonb_array_elements(c->'artists') loop
   if not exists(select 1 from private.artist_providers where provider='spotify' and provider_id=a->>'id') and exists(select 1 from public.artists where lower(btrim(name))=lower(btrim(a->>'name'))) then reasons:=reasons||'"artist_name_collision"'::jsonb; exit; end if;
  end loop;
 end if;
 return jsonb_build_object('evidence_version',2,'same_run_peers','[]'::jsonb,'match_catalog',coalesce((select jsonb_agg(private.import_catalog_evidence(t.id) order by t.id) from public.tracks t where matches ? t.id::text),'[]'::jsonb),'reasons',reasons,'matches',matches,'identity',private.import_identity(c),'release_date',c->'release_date','release_precision',c->'release_precision','known_track',m.track_id,'accepted_identity',m.identity);
end $$;

-- Record peer identities in the checksummed plan before any item is admitted.
create function private.import_plan_evidence(p_season uuid,p_run uuid,p_position integer,c jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; peers jsonb;
begin
 result:=private.import_evidence(p_season,c);
 if c->>'kind'<>'track' or result->>'known_track' is not null then return result; end if;
 select coalesce(jsonb_agg(jsonb_build_object('position',j.position,'provider_id',j.candidate->>'id',
  'identity',private.import_identity(j.candidate),'release_date',j.candidate->'release_date',
  'release_precision',j.candidate->'release_precision') order by j.position),'[]'::jsonb) into peers
 from private.import_items j where j.run_id=p_run and j.position<>p_position
 and j.candidate->>'kind'='track' and j.candidate->>'id'<>c->>'id'
 and not(j.evidence->'reasons' ? 'duplicate_occurrence')
 and ((c->>'isrc' is not null and j.candidate->>'isrc'=c->>'isrc')
 or private.import_title_key(j.candidate->>'title')=private.import_title_key(c->>'title'));
 result:=result||jsonb_build_object('same_run_peers',peers);
 if jsonb_array_length(peers)>0 and not(result->'reasons' ? 'suspected_match') then
  result:=result||jsonb_build_object('reasons',(result->'reasons')||'"suspected_match"'::jsonb);
 end if;
 return result;
end $$;

-- Compare every material catalog-match field. Only new UUIDs created by explicitly
-- reviewed distinct peers in THIS immutable plan may be omitted from comparison.
create function private.import_review_evidence_matches(p_run uuid,p_position integer,p_before jsonb,p_after jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare peer private.import_items; peer_track text; remaining jsonb:=p_after; entry jsonb; new_match jsonb;
begin
 if p_before->>'evidence_version' is distinct from '2' then return false; end if;
 if p_before=p_after then return true; end if;
 for entry in select value from jsonb_array_elements(p_before->'same_run_peers') loop
  select * into peer from private.import_items where run_id=p_run and position=(entry->>'position')::integer;
  peer_track:=peer.receipt->>'track_id';
  if peer.position=p_position or peer.decision->>'action' is distinct from 'distinct'
   or peer.receipt->'new_track' is distinct from 'true'::jsonb or peer_track is null
   or entry->>'provider_id' is distinct from peer.candidate->>'id'
   or entry->'identity' is distinct from private.import_identity(peer.candidate)
   or entry->'release_date' is distinct from peer.candidate->'release_date'
   or entry->'release_precision' is distinct from peer.candidate->'release_precision'
   or p_before->'matches' ? peer_track then continue; end if;
  -- Verify this matching catalog row is still the exact peer that was reviewed/applied.
  select value into new_match from jsonb_array_elements(remaining->'match_catalog') where value->>'id'=peer_track;
  if new_match is null or new_match is distinct from peer.receipt->'catalog_evidence' or new_match->>'title' is distinct from peer.candidate->>'title'
   or not exists(select 1 from private.track_providers p where p.provider='spotify'
    and p.provider_id=peer.candidate->>'id' and p.track_id::text=peer_track
    and p.identity=private.import_identity(peer.candidate)
    and p.accepted_isrcs=private.import_retained_isrcs('{}'::text[],peer.candidate)) then continue; end if;
  -- Another mapping/baseline added to this peer is new material evidence too.
  if jsonb_array_length(new_match->'providers')<>1 then continue; end if;
  remaining:=jsonb_set(remaining,'{matches}',coalesce((select jsonb_agg(v order by v) from jsonb_array_elements(remaining->'matches') t(v) where v<>to_jsonb(peer_track)),'[]'::jsonb));
  remaining:=jsonb_set(remaining,'{match_catalog}',coalesce((select jsonb_agg(v order by v->>'id') from jsonb_array_elements(remaining->'match_catalog') t(v) where v->>'id'<>peer_track),'[]'::jsonb));
 end loop;
 return remaining=p_before;
end $$;

-- Preserve unchanged legacy year/date-only decisions on a fresh v2 plan.
-- Legacy suspected-match approvals lack the strengthened material evidence and
-- peer binding, so they are intentionally ineligible for this compatibility path.
create function private.import_review_decision(p_season uuid,c jsonb,p_evidence jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 select decision into result from private.import_reviews where season_id=p_season and provider='spotify'
 and provider_id=c->>'id' and evidence=p_evidence;
 if result is not null then return result; end if;
 if p_evidence->'matches'='[]'::jsonb and p_evidence->'same_run_peers'='[]'::jsonb
 and p_evidence->'reasons'<>'[]'::jsonb and '["release_year","unknown_release_date"]'::jsonb @> (p_evidence->'reasons') then
  select decision into result from private.import_reviews where season_id=p_season and provider='spotify'
   and provider_id=c->>'id' and evidence=(p_evidence-'evidence_version'-'same_run_peers');
 end if;
 return result;
end $$;

create or replace function public.create_import_plan(p_season uuid,p_run uuid,p_source_version bigint,p_source text,p_market text,p_snapshot text,p_candidates jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.seasons; cfg private.season_sources; c jsonb; ev jsonb; dec jsonb; pos integer:=0; payload jsonb; r private.import_runs; items jsonb:='[]'::jsonb; seen text[]:='{}'::text[]; checksum text; item private.import_items;
begin
 s:=private.import_admin(p_season);
 if s.state not in ('SETUP','VOTING') then raise exception 'catalog_closed'; end if;
 select * into cfg from private.season_sources where season_id=p_season;
 if cfg.version is distinct from p_source_version or cfg.source_id is distinct from p_source then raise exception 'stale_source'; end if;
 if p_snapshot is null or length(p_snapshot) not between 1 and 200 or jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>5000 then raise exception 'invalid_plan'; end if;
 payload:=jsonb_build_object('candidates',p_candidates,'source',p_source,'version',p_source_version,'market',p_market,'snapshot',p_snapshot);
 checksum:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 select * into r from private.import_runs where id=p_run;
 if found then
  if r.actor_id<>auth.uid() or r.season_id<>p_season or r.plan<>payload then raise exception 'plan_payload_conflict'; end if;
  return public.read_import_plan(p_run);
 end if;
 insert into private.import_runs(id,season_id,actor_id,source_version,source_id,market,snapshot,checksum,plan) values(p_run,p_season,auth.uid(),p_source_version,p_source,p_market,p_snapshot,checksum,payload);
 for c in select value from jsonb_array_elements(p_candidates) loop
  c:=private.import_candidate(c); ev:=jsonb_build_object('evidence_version',2,'same_run_peers','[]'::jsonb,'reasons','[]'::jsonb,'identity',private.import_identity(c)); dec:=null;
  if c->>'kind'='track' and c->>'id'=any(seen) then ev:=ev||jsonb_build_object('reasons',jsonb_build_array('duplicate_occurrence'));
  else
   dec:=private.import_review_decision(p_season,c,ev);
   seen:=array_append(seen,c->>'id');
  end if;
  insert into private.import_items(run_id,position,candidate,evidence,decision) values(p_run,pos,c,ev,dec); pos:=pos+1;
 end loop;
 -- Resolve all peer evidence after staging the full scan, using one collision predicate.
 for item in select * from private.import_items where run_id=p_run order by position loop
  if item.evidence->'reasons' ? 'duplicate_occurrence' then continue; end if;
  ev:=private.import_plan_evidence(p_season,p_run,item.position,item.candidate); dec:=null;
  dec:=private.import_review_decision(p_season,item.candidate,ev);
  update private.import_items set evidence=ev,decision=dec where run_id=p_run and position=item.position;
 end loop;
 select jsonb_agg(jsonb_build_object('candidate',candidate,'evidence',evidence) order by position) into items from private.import_items where run_id=p_run;
 update private.import_runs set checksum=encode(sha256(convert_to((payload||jsonb_build_object('items',coalesce(items,'[]')))::text,'UTF8')),'hex'),
 status=case when exists(select 1 from private.import_items where run_id=p_run and evidence->'reasons'<>'[]'::jsonb and not (evidence->'reasons' ? 'duplicate_occurrence') and candidate->>'kind'<>'skipped') then 'review-required' else 'complete' end where id=p_run;
 return public.read_import_plan(p_run);
end $$;
create or replace function public.apply_import_item(p_run uuid,p_checksum text,p_position integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.import_runs; i private.import_items; s public.seasons; cfg private.season_sources; ev jsonb; c jsonb; m private.track_providers; tid uuid; aid uuid; a jsonb; n integer:=0; added integer:=0; new_track boolean:=false; new_artists integer:=0; new_mapping boolean:=false; result jsonb; active boolean; refresh_artwork boolean;
begin
 select * into r from private.import_runs where id=p_run;
 if not found then raise exception 'import_not_available' using errcode='42501'; end if;
 s:=private.import_admin(r.season_id);
 if r.actor_id<>auth.uid() then raise exception 'import_not_available' using errcode='42501'; end if;
 if r.checksum is distinct from p_checksum then raise exception 'stale_plan'; end if;
 select * into i from private.import_items where run_id=p_run and position=p_position;
 if not found then raise exception 'item_not_available'; end if;
 -- Durable receipt recovery is read-only even after source replacement or closure.
 if i.receipt is not null then return i.receipt; end if;
 if s.state not in ('SETUP','VOTING') then raise exception 'catalog_closed'; end if;
 select * into cfg from private.season_sources where season_id=r.season_id;
 if cfg.version is distinct from r.source_version then raise exception 'stale_source'; end if;
 c:=private.import_candidate(i.candidate);
 if c->>'kind'<>'track' or i.evidence->'reasons' ? 'duplicate_occurrence' then
  result:=jsonb_build_object('outcome',case when c->>'kind'='skipped' or i.evidence->'reasons' ? 'duplicate_occurrence' then 'skipped' else 'review-required' end);
 elsif i.decision->>'action' in ('defer','decline') then result:=jsonb_build_object('outcome',i.decision->>'action');
 else
  ev:=private.import_plan_evidence(r.season_id,p_run,p_position,c);
  -- Exact clean provider-ID reuse remains safe; exception approvals never cover
  -- arbitrary growth of the material match set.
  if ev is distinct from i.evidence and not (ev->'reasons'='[]'::jsonb and i.evidence->'reasons'='[]'::jsonb)
   and not (i.decision->>'action'='distinct' and private.import_review_evidence_matches(p_run,p_position,i.evidence,ev)) then
   return jsonb_build_object('outcome','review-required','reason','evidence_changed');
  end if;
  if jsonb_array_length(ev->'reasons')>0 and (i.decision is null or i.decision->>'action' not in ('distinct','attach','keep')) then return jsonb_build_object('outcome','review-required'); end if;
  select * into m from private.track_providers where provider='spotify' and provider_id=c->>'id'; tid:=m.track_id;
  if tid is null then
   if i.decision->>'action'='attach' then tid:=(i.decision->>'target')::uuid;
   else
    insert into public.tracks(title,spotify_url,artwork_url) values(c->>'title',c->>'url',c->>'artwork') returning id into tid; new_track:=true;
    for a in select value from jsonb_array_elements(c->'artists') loop
     select artist_id into aid from private.artist_providers where provider='spotify' and provider_id=a->>'id';
     if aid is null then
      insert into public.artists(name) values(a->>'name') returning id into aid; new_artists:=new_artists+1;
      insert into private.artist_providers(provider,provider_id,artist_id,observed_name) values('spotify',a->>'id',aid,a->>'name');
     else update private.artist_providers set observed_name=a->>'name' where provider='spotify' and provider_id=a->>'id'; end if;
     if not exists(select 1 from public.track_artists where track_id=tid and artist_id=aid) then
      insert into public.track_artists(track_id,artist_id,credit_order) values(tid,aid,n); n:=n+1;
     end if;
    end loop;
   end if;
   insert into private.track_providers(provider,provider_id,track_id,identity,observation,selected_artwork,accepted_isrcs) values('spotify',c->>'id',tid,private.import_identity(c),c,case when new_track then c->>'artwork' else null end,private.import_retained_isrcs('{}'::text[],c)); new_mapping:=true;
  else
   -- Never overwrite canonical title/credits; curated artwork wins.
   select not artwork_curated and artwork_url is not distinct from m.selected_artwork into refresh_artwork from public.tracks where id=tid;
   update public.tracks set spotify_url=case when spotify_url is null or spotify_url=c->>'url' then c->>'url' else spotify_url end,
    artwork_url=case when refresh_artwork then c->>'artwork' else artwork_url end where id=tid;
   update private.track_providers set identity=private.import_optional_baseline(m.identity,c),accepted_isrcs=private.import_retained_isrcs(m.accepted_isrcs,c),observation=c,last_seen=clock_timestamp(),selected_artwork=case when refresh_artwork then c->>'artwork' else m.selected_artwork end where provider='spotify' and provider_id=c->>'id';
  end if;
  for a in select value from jsonb_array_elements(c->'artists') loop
   update private.artist_providers set observed_name=a->>'name' where provider='spotify' and provider_id=a->>'id';
  end loop;
  insert into public.season_tracks(season_id,track_id,added_by) values(r.season_id,tid,auth.uid()) on conflict do nothing;
  get diagnostics added=row_count;
  select st.active into active from public.season_tracks st where season_id=r.season_id and track_id=tid;
  if i.decision->>'action' in ('distinct','attach','keep') then
   insert into private.import_reviews(season_id,provider,provider_id,evidence,decision,actor_id) values(r.season_id,'spotify',c->>'id',private.import_evidence(r.season_id,c),i.decision,auth.uid()) on conflict(season_id,provider,provider_id,evidence) do nothing;
  end if;
  result:=jsonb_build_object('outcome',case when not active then 'already-withdrawn' when added=1 then 'added' else 'already-present' end,'track_id',tid,'new_track',new_track,'new_artists',new_artists,'new_mapping',new_mapping,'catalog_evidence',case when new_track then private.import_catalog_evidence(tid) else null end);
 end if;
 update private.import_items set receipt=case when result->>'outcome' in ('defer','decline','review-required') then null else result end where run_id=p_run and position=p_position;
 update private.import_runs set mode='apply',status='partial',updated_at=clock_timestamp() where id=p_run;
 return result;
end $$;

revoke all on function private.import_review_decision(uuid,jsonb,jsonb),private.import_catalog_evidence(uuid),private.import_title_key(text),private.import_optional_baseline(jsonb,jsonb),private.import_retained_isrcs(text[],jsonb),private.import_plan_evidence(uuid,uuid,integer,jsonb),private.import_review_evidence_matches(uuid,integer,jsonb,jsonb) from public,anon,authenticated,service_role;
-- CREATE OR REPLACE preserves existing ACLs; explicitly retain the narrow boundary.
revoke all on function private.import_candidate(jsonb),private.import_evidence(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.create_import_plan(uuid,uuid,bigint,text,text,text,jsonb),public.apply_import_item(uuid,text,integer) from public,anon,service_role;
grant execute on function public.create_import_plan(uuid,uuid,bigint,text,text,text,jsonb),public.apply_import_item(uuid,text,integer) to authenticated;
