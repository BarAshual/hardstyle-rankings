-- Additive correction: bind artist-name collisions to material catalog evidence
-- and exact explicitly reviewed peers. No mappings, receipts, or history rewritten.
create function private.import_artist_names(c jsonb) returns text[]
language sql immutable set search_path='' as $$
 select coalesce(array_agg(distinct lower(btrim(a->>'name'))),'{}'::text[])
 from jsonb_array_elements(case when jsonb_typeof(c->'artists')='array' then c->'artists' else '[]'::jsonb end) a
$$;
create index import_items_artist_names on private.import_items using gin(private.import_artist_names(candidate));
create index import_artist_name on public.artists(lower(btrim(name)));

create function private.import_artist_evidence(p_artist uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',a.id,'name',a.name,'providers',coalesce((
  select jsonb_agg(jsonb_build_object('provider',p.provider,'id',p.provider_id) order by p.provider,p.provider_id)
  from private.artist_providers p where p.artist_id=a.id),'[]'::jsonb))
 from public.artists a where a.id=p_artist
$$;
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
  select coalesce(jsonb_agg(distinct t.id order by t.id),'[]') into matches from public.tracks t
  left join private.track_providers p on p.track_id=t.id
  where (c->>'isrc' is not null and p.accepted_isrcs @> array[c->>'isrc'])
   or private.import_title_key(t.title)=private.import_title_key(c->>'title')
   or (c->>'original_id' is not null and p.provider='spotify' and p.provider_id=c->>'original_id');
  if jsonb_array_length(matches)>0 then reasons:=reasons||'"suspected_match"'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object('incoming_provider_id',a->>'id',
   'artist',private.import_artist_evidence(t.id)) order by a->>'id',t.id),'[]'::jsonb) into artist_matches
  from jsonb_array_elements(c->'artists') a join public.artists t on lower(btrim(t.name))=lower(btrim(a->>'name'))
  where not exists(select 1 from private.artist_providers p where p.provider='spotify' and p.provider_id=a->>'id');
  if jsonb_array_length(artist_matches)>0 then reasons:=reasons||'"artist_name_collision"'::jsonb; end if;
 end if;
 return jsonb_build_object('evidence_version',3,'same_run_peers','[]'::jsonb,'same_run_artist_peers','[]'::jsonb,'artist_matches',artist_matches,'match_catalog',coalesce((select jsonb_agg(private.import_catalog_evidence(t.id) order by t.id) from public.tracks t where matches ? t.id::text),'[]'::jsonb),'reasons',reasons,'matches',matches,'identity',private.import_identity(c),'release_date',c->'release_date','release_precision',c->'release_precision','known_track',m.track_id,'accepted_identity',m.identity);
end $$;

create or replace function private.import_plan_evidence(p_season uuid,p_run uuid,p_position integer,c jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; peers jsonb; artist_peers jsonb;
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
 select coalesce(jsonb_agg(jsonb_build_object('position',j.position,'provider_id',j.candidate->>'id',
  'identity',private.import_identity(j.candidate),'artists',j.candidate->'artists',
  'release_date',j.candidate->'release_date','release_precision',j.candidate->'release_precision') order by j.position),'[]'::jsonb)
 into artist_peers from private.import_items j
 where j.run_id=p_run and j.position<>p_position and j.candidate->>'kind'='track'
 and j.candidate->>'id'<>c->>'id' and not(j.evidence->'reasons' ? 'duplicate_occurrence')
 and private.import_artist_names(j.candidate) && private.import_artist_names(c)
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

create or replace function private.import_review_evidence_matches(p_run uuid,p_position integer,p_before jsonb,p_after jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare peer private.import_items; peer_track text; remaining jsonb:=p_after; entry jsonb; new_match jsonb; artist_match jsonb; credited jsonb; provider_artist jsonb;
begin
 if p_before->>'evidence_version' is distinct from '3' then return false; end if;
 if p_before=p_after then return true; end if;
 for entry in select value from jsonb_array_elements((p_before->'same_run_peers')||(p_before->'same_run_artist_peers')) loop
  select * into peer from private.import_items where run_id=p_run and position=(entry->>'position')::integer;
  peer_track:=peer.receipt->>'track_id';
  if peer.position=p_position or peer.decision->>'action' is distinct from 'distinct'
   or peer.receipt->'new_track' is distinct from 'true'::jsonb or peer_track is null
   or entry->>'provider_id' is distinct from peer.candidate->>'id'
   or entry->'identity' is distinct from private.import_identity(peer.candidate)
   or entry->'release_date' is distinct from peer.candidate->'release_date'
   or entry->'release_precision' is distinct from peer.candidate->'release_precision'
   or (entry ? 'artists' and entry->'artists' is distinct from peer.candidate->'artists') then continue; end if;
  -- Verify the current peer catalog still equals its durable admission evidence.
  new_match:=private.import_catalog_evidence(peer_track::uuid);
  if new_match is null or new_match is distinct from peer.receipt->'catalog_evidence' or new_match->>'title' is distinct from peer.candidate->>'title'
   or not exists(select 1 from private.track_providers p where p.provider='spotify'
    and p.provider_id=peer.candidate->>'id' and p.track_id::text=peer_track
    and p.identity=private.import_identity(peer.candidate)
    and p.accepted_isrcs=private.import_retained_isrcs('{}'::text[],peer.candidate)) then continue; end if;
  -- Another mapping/baseline added to this peer is new material evidence too.
  if jsonb_array_length(new_match->'providers')<>1 then continue; end if;
  if (p_before->'same_run_peers') @> jsonb_build_array(entry) and not(p_before->'matches' ? peer_track) then
   remaining:=jsonb_set(remaining,'{matches}',coalesce((select jsonb_agg(v order by v) from jsonb_array_elements(remaining->'matches') t(v) where v<>to_jsonb(peer_track)),'[]'::jsonb));
   remaining:=jsonb_set(remaining,'{match_catalog}',coalesce((select jsonb_agg(v order by v->>'id') from jsonb_array_elements(remaining->'match_catalog') t(v) where v->>'id'<>peer_track),'[]'::jsonb));
  end if;
  if not ((p_before->'same_run_artist_peers') @> jsonb_build_array(entry)) then continue; end if;
  for artist_match in select value from jsonb_array_elements(remaining->'artist_matches') loop
   if (p_before->'artist_matches') @> jsonb_build_array(artist_match) then continue; end if;
   select value into credited from jsonb_array_elements(new_match->'artists') where value->>'id'=artist_match->'artist'->>'id';
   select value into provider_artist from jsonb_array_elements(peer.candidate->'artists') where value->>'name'=credited->>'name'
    and exists(select 1 from private.artist_providers p where p.provider='spotify' and p.provider_id=value->>'id'
     and p.artist_id::text=credited->>'id');
   -- The exact artist must be a peer credit with the original name and its sole
   -- exact provider mapping. Additional mappings/renames are material changes.
   if credited is null or provider_artist is null or artist_match->'artist' is distinct from
    jsonb_build_object('id',credited->'id','name',credited->'name','providers',jsonb_build_array(
     jsonb_build_object('provider','spotify','id',provider_artist->>'id'))) then continue; end if;
   if not exists(select 1 from private.import_items i, jsonb_array_elements(i.candidate->'artists') a
    where i.run_id=p_run and i.position=p_position and a->>'id'=artist_match->>'incoming_provider_id'
    and a->>'id'<>provider_artist->>'id' and lower(btrim(a->>'name'))=lower(btrim(provider_artist->>'name'))) then continue; end if;
   remaining:=jsonb_set(remaining,'{artist_matches}',coalesce((select jsonb_agg(v order by v->>'incoming_provider_id',v->'artist'->>'id')
    from jsonb_array_elements(remaining->'artist_matches') t(v) where v<>artist_match),'[]'::jsonb));
  end loop;
 end loop;
 return remaining=p_before;
end $$;

-- Preserve legacy/v2 date-only decisions only when all collision sets are empty.
-- Match/artist approvals require the complete current evidence contract.
create or replace function private.import_review_decision(p_season uuid,c jsonb,p_evidence jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 select decision into result from private.import_reviews where season_id=p_season and provider='spotify'
 and provider_id=c->>'id' and evidence=p_evidence;
 if result is not null then return result; end if;
 if p_evidence->'matches'='[]'::jsonb and p_evidence->'same_run_peers'='[]'::jsonb and p_evidence->'same_run_artist_peers'='[]'::jsonb and p_evidence->'artist_matches'='[]'::jsonb
 and p_evidence->'reasons'<>'[]'::jsonb and '["release_year","unknown_release_date"]'::jsonb @> (p_evidence->'reasons') then
  select decision into result from private.import_reviews where season_id=p_season and provider='spotify'
   and provider_id=c->>'id' and (evidence=(p_evidence-'evidence_version'-'same_run_peers'-'same_run_artist_peers'-'artist_matches') or evidence=((p_evidence-'same_run_artist_peers'-'artist_matches')||jsonb_build_object('evidence_version',2)));
 end if;
 return result;
end $$;

revoke all on function private.import_artist_names(jsonb),private.import_artist_evidence(uuid),private.import_evidence(uuid,jsonb),private.import_plan_evidence(uuid,uuid,integer,jsonb),private.import_review_evidence_matches(uuid,integer,jsonb,jsonb),private.import_review_decision(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
