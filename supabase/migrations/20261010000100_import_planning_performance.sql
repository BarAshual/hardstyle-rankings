-- Additive performance correction. Evidence JSON and review semantics are unchanged.
-- Store immutable derived names once, including for existing staged rows. A run-ID
-- scan must not re-expand artist JSON for every candidate/peer pair when the
-- planner prefers it to GIN (notably before staging statistics are available).
alter table private.import_items add column artist_name_keys text[]
 generated always as (private.import_artist_names(candidate)) stored;
drop index private.import_items_artist_names;
create index import_items_artist_name_keys on private.import_items using gin(artist_name_keys);

-- Cache incoming keys once; independent title/ISRC probes avoid a parameterized
-- OR scan and retain the exact existing collision predicates and peer payloads.
create or replace function private.import_plan_evidence(p_season uuid,p_run uuid,p_position integer,c jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; peers jsonb; artist_peers jsonb; artist_names text[]; title_key text; isrc text;
begin
 result:=private.import_evidence(p_season,c);
 if c->>'kind'<>'track' or result->>'known_track' is not null then return result; end if;
 artist_names:=private.import_artist_names(c); title_key:=private.import_title_key(c->>'title'); isrc:=c->>'isrc';
 select coalesce(jsonb_agg(jsonb_build_object('position',j.position,'provider_id',j.candidate->>'id',
  'identity',private.import_identity(j.candidate),'release_date',j.candidate->'release_date',
  'release_precision',j.candidate->'release_precision') order by j.position),'[]'::jsonb) into peers
 from private.import_items j where j.run_id=p_run and j.position<>p_position
 and j.candidate->>'kind'='track' and j.candidate->>'id'<>c->>'id'
 and not(j.evidence->'reasons' ? 'duplicate_occurrence')
 and j.position in (
  select k.position from private.import_items k where k.run_id=p_run and k.candidate->>'kind'='track'
   and private.import_title_key(k.candidate->>'title')=title_key
  union
  select k.position from private.import_items k where k.run_id=p_run and k.candidate->>'kind'='track'
   and isrc is not null and k.candidate->>'isrc'=isrc);
 result:=result||jsonb_build_object('same_run_peers',peers);
 if jsonb_array_length(peers)>0 and not(result->'reasons' ? 'suspected_match') then
  result:=result||jsonb_build_object('reasons',(result->'reasons')||'"suspected_match"'::jsonb);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('position',j.position,'provider_id',j.candidate->>'id',
  'identity',private.import_identity(j.candidate),'artists',j.candidate->'artists',
  'release_date',j.candidate->'release_date','release_precision',j.candidate->'release_precision') order by j.position),'[]'::jsonb)
 into artist_peers from private.import_items j
 where j.run_id=p_run and j.position<>p_position and j.candidate->>'kind'='track'
 and j.candidate->>'id'<>c->>'id' and not(j.evidence->'reasons' ? 'duplicate_occurrence')
 and j.artist_name_keys && artist_names
 and exists(select 1 from jsonb_array_elements(c->'artists') a, jsonb_array_elements(j.candidate->'artists') b
  where a->>'id'<>b->>'id' and lower(btrim(a->>'name'))=lower(btrim(b->>'name'))
  and not exists(select 1 from private.artist_providers p where p.provider='spotify' and p.provider_id=a->>'id'));
 -- Peer membership is immutable: admission of a peer must not remove it from the
 -- staged evidence. Exact provider reuse by this candidate bypasses collisions.
 result:=result||jsonb_build_object('same_run_artist_peers',artist_peers);
 if jsonb_array_length(artist_peers)>0 and not(result->'reasons' ? 'artist_name_collision') then
  result:=result||jsonb_build_object('reasons',(result->'reasons')||'"artist_name_collision"'::jsonb);
 end if;
 result:=jsonb_set(result,'{reasons}',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from jsonb_array_elements(result->'reasons') t(v)));
 return result;
end $$;


-- Preserve all external matches while probing existing ISRC/provider indexes
-- and a normalized canonical title index rather than scanning the full catalog.
create index import_track_title_key on public.tracks(private.import_title_key(title));

create or replace function private.import_evidence(p_season uuid,c jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare reasons jsonb:='[]'::jsonb; matches jsonb:='[]'::jsonb; m private.track_providers; yr integer; known boolean; artist_matches jsonb:='[]'::jsonb;
begin
 if c->>'kind'<>'track' then return jsonb_build_object('evidence_version',3,'same_run_peers','[]'::jsonb,'same_run_artist_peers','[]'::jsonb,'artist_matches',artist_matches,'reasons',jsonb_build_array(c->>'kind'),'matches','[]'::jsonb,'identity',private.import_identity(c),'release_date',c->'release_date','release_precision',c->'release_precision'); end if;
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
  select coalesce(jsonb_agg(matched.id order by matched.id),'[]') into matches from (
   select t.id from public.tracks t where private.import_title_key(t.title)=private.import_title_key(c->>'title')
   union
   select p.track_id from private.track_providers p where c->>'isrc' is not null and p.accepted_isrcs @> array[c->>'isrc']
   union
   select p.track_id from private.track_providers p where c->>'original_id' is not null
    and p.provider='spotify' and p.provider_id=c->>'original_id'
  ) matched;
  if jsonb_array_length(matches)>0 then reasons:=reasons||'"suspected_match"'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object('incoming_provider_id',a->>'id',
   'artist',private.import_artist_evidence(t.id)) order by a->>'id',t.id),'[]'::jsonb) into artist_matches
  from jsonb_array_elements(c->'artists') a join public.artists t on lower(btrim(t.name))=lower(btrim(a->>'name'))
  where not exists(select 1 from private.artist_providers p where p.provider='spotify' and p.provider_id=a->>'id');
  if jsonb_array_length(artist_matches)>0 then reasons:=reasons||'"artist_name_collision"'::jsonb; end if;
 end if;
 return jsonb_build_object('evidence_version',3,'same_run_peers','[]'::jsonb,'same_run_artist_peers','[]'::jsonb,'artist_matches',artist_matches,'match_catalog',coalesce((select jsonb_agg(private.import_catalog_evidence(t.id) order by t.id) from jsonb_array_elements_text(matches) matched_id(id) join public.tracks t on t.id=matched_id.id::uuid),'[]'::jsonb),'reasons',reasons,'matches',matches,'identity',private.import_identity(c),'release_date',c->'release_date','release_precision',c->'release_precision','known_track',m.track_id,'accepted_identity',m.identity);
end $$;

