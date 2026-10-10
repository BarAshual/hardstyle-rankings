-- Provider identities and importer bookkeeping are private; existing projections stay intact.
-- Explicit curation intent is independent of whether the selected URL changes.
alter table public.tracks add column artwork_curated boolean not null default false;
create table private.track_providers (
 provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
 provider_id text not null check (length(provider_id) between 1 and 200),
 track_id uuid not null references public.tracks on delete restrict,
 identity jsonb not null, observation jsonb not null,
 selected_artwork text, first_seen timestamptz not null default clock_timestamp(),
 last_seen timestamptz not null default clock_timestamp(), primary key(provider,provider_id)
);
create index track_providers_track on private.track_providers(track_id);
create index track_providers_isrc on private.track_providers((observation->>'isrc'));
create table private.artist_providers (
 provider text not null, provider_id text not null,
 artist_id uuid not null references public.artists on delete restrict,
 observed_name text not null, primary key(provider,provider_id)
);
create index artist_providers_artist on private.artist_providers(artist_id);
create table private.season_sources (
 season_id uuid primary key references public.seasons on delete restrict,
 provider text not null default 'spotify' check(provider='spotify'),
 source_id text not null check(source_id ~ '^[A-Za-z0-9]{22}$'),
 market text not null default 'IL' check(market ~ '^[A-Z]{2}$'), version bigint not null
);
create table private.source_events (
 id uuid primary key default gen_random_uuid(), season_id uuid not null references public.seasons,
 actor_id uuid not null references auth.users, before_config jsonb, after_config jsonb not null,
 reason text not null check(length(btrim(reason)) between 1 and 500), at timestamptz not null default clock_timestamp()
);
create table private.import_runs (
 id uuid primary key, season_id uuid not null references public.seasons,
 actor_id uuid not null references auth.users, source_version bigint not null,
 source_id text not null, market text not null check(market ~ '^[A-Z]{2}$'), snapshot text not null,
 checksum text not null, plan jsonb not null, mode text not null default 'dry-run' check(mode in ('dry-run','apply')),
 status text not null default 'review-required' check(status in ('complete','partial','failed','interrupted','review-required')),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table private.import_items (
 run_id uuid not null references private.import_runs, position integer not null,
 candidate jsonb not null, evidence jsonb not null, decision jsonb, receipt jsonb,
 primary key(run_id,position)
);
create table private.import_reviews (
 season_id uuid not null references public.seasons, provider text not null, provider_id text not null,
 evidence jsonb not null, decision jsonb not null, actor_id uuid not null references auth.users,
 at timestamptz not null default clock_timestamp(), primary key(season_id,provider,provider_id,evidence)
);
create table private.import_review_events (
 id uuid primary key default gen_random_uuid(), run_id uuid not null references private.import_runs,
 position integer not null, actor_id uuid not null references auth.users,
 evidence jsonb not null, decision jsonb not null, at timestamptz not null default clock_timestamp(),
 foreign key(run_id,position) references private.import_items
);
create trigger source_events_immutable before update or delete or truncate on private.source_events for each statement execute function private.immutable_event();
create trigger import_review_events_immutable before update or delete or truncate on private.import_review_events for each statement execute function private.immutable_event();
alter table private.import_review_events enable row level security;
revoke all on private.import_review_events from public,anon,authenticated,service_role;
-- No direct API access, even for admins or service-role clients.
alter table private.track_providers enable row level security;
alter table private.artist_providers enable row level security;
alter table private.season_sources enable row level security;
alter table private.source_events enable row level security;
alter table private.import_runs enable row level security;
alter table private.import_items enable row level security;
alter table private.import_reviews enable row level security;
revoke all on private.track_providers,private.artist_providers,private.season_sources,private.source_events,private.import_runs,private.import_items,private.import_reviews from public,anon,authenticated,service_role;

create function private.import_admin(p_season uuid) returns public.seasons
language plpgsql security definer set search_path='' as $$
declare s public.seasons;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'read_committed_required' using errcode='25000'; end if;
 -- Global catalog lock first, then season: mappings can be shared across seasons.
 perform pg_catalog.pg_advisory_xact_lock(18437,20261007);
 perform private.google_email();
 s:=private.lock_admin_season(p_season);
 if not private.is_admin(p_season) then raise exception 'season_admin_required' using errcode='42501'; end if;
 return s;
end $$;
create function public.designate_import_source(p_season uuid,p_source text,p_market text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.seasons; old jsonb; result jsonb;
begin
 s:=private.import_admin(p_season);
 if s.state not in ('SETUP','VOTING') then raise exception 'catalog_closed'; end if;
 select to_jsonb(c) into old from private.season_sources c where season_id=p_season;
 insert into private.season_sources(season_id,source_id,market,version) values(p_season,p_source,coalesce(p_market,'IL'),1)
 on conflict(season_id) do update set source_id=excluded.source_id,market=excluded.market,version=private.season_sources.version+1;
 select to_jsonb(c) into result from private.season_sources c where season_id=p_season;
 insert into private.source_events(season_id,actor_id,before_config,after_config,reason) values(p_season,auth.uid(),old,result,p_reason);
 return result;
end $$;
create function public.import_context(p_season uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.seasons; result jsonb;
begin
 s:=private.import_admin(p_season);
 if s.state not in ('SETUP','VOTING') then raise exception 'catalog_closed'; end if;
 select to_jsonb(c) into result from private.season_sources c where season_id=p_season;
 if result is null then raise exception 'source_not_designated'; end if;
 return result || jsonb_build_object('year',s.year,'state',s.state);
end $$;
create function private.import_identity(c jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('title',c->'title','artists',coalesce((select jsonb_agg(a->>'id' order by n) from jsonb_array_elements(c->'artists') with ordinality t(a,n)),'[]'::jsonb),'duration_ms',c->'duration_ms','isrc',c->'isrc')
$$;
-- Small allowlist: raw API dumps/owners/headers cannot enter private records.
create function private.import_candidate(c jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare a jsonb; allowed text[]:=array['id','title','artists','duration_ms','isrc','release_date','release_precision','album','artwork','url','available','original_id','kind'];
begin
 if jsonb_typeof(c)<>'object' or exists(select 1 from jsonb_object_keys(c) k where not(k=any(allowed))) or length(c::text)>16000 then raise exception 'invalid_candidate' using errcode='22023'; end if;
 if c->>'kind' in ('skipped','removed','invalid') then return c; end if;
 if c->>'kind' is distinct from 'track' or coalesce(c->>'id','') !~ '^[A-Za-z0-9]{22}$' or length(btrim(coalesce(c->>'title',''))) not between 1 and 500 or jsonb_typeof(c->'artists') is distinct from 'array' or jsonb_array_length(c->'artists') not between 1 and 30 then raise exception 'invalid_candidate' using errcode='22023'; end if;
 if c->'duration_ms' is not null and c->'duration_ms'<>'null'::jsonb and (jsonb_typeof(c->'duration_ms')<>'number' or (c->>'duration_ms') !~ '^[0-9]{1,8}$') then raise exception 'invalid_candidate' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(c->'artists') loop
  if coalesce(a->>'id','') !~ '^[A-Za-z0-9]{22}$' or length(btrim(coalesce(a->>'name',''))) not between 1 and 300 or exists(select 1 from jsonb_object_keys(a) k where k not in ('id','name')) then raise exception 'invalid_candidate' using errcode='22023'; end if;
 end loop;
 if c->>'url' is distinct from 'https://open.spotify.com/track/'||(c->>'id') or (c->>'artwork' is not null and c->>'artwork' !~ '^https://i\.scdn\.co/image/[A-Za-z0-9]+$') then raise exception 'invalid_candidate_url' using errcode='22023'; end if;
 return c;
end $$;
create function private.import_evidence(p_season uuid,c jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare reasons jsonb:='[]'::jsonb; matches jsonb:='[]'::jsonb; m private.track_providers; yr integer; a jsonb; known boolean;
begin
 if c->>'kind'<>'track' then return jsonb_build_object('reasons',jsonb_build_array(c->>'kind'),'matches','[]'::jsonb,'identity',private.import_identity(c),'release_date',c->'release_date','release_precision',c->'release_precision'); end if;
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
  where (c->>'isrc' is not null and p.observation->>'isrc'=c->>'isrc')
   or lower(regexp_replace(t.title,'\s+',' ','g'))=lower(regexp_replace(c->>'title','\s+',' ','g'))
   or (c->>'original_id' is not null and p.provider='spotify' and p.provider_id=c->>'original_id');
  if jsonb_array_length(matches)>0 then reasons:=reasons||'"suspected_match"'::jsonb; end if;
  for a in select value from jsonb_array_elements(c->'artists') loop
   if not exists(select 1 from private.artist_providers where provider='spotify' and provider_id=a->>'id') and exists(select 1 from public.artists where lower(btrim(name))=lower(btrim(a->>'name'))) then reasons:=reasons||'"artist_name_collision"'::jsonb; exit; end if;
  end loop;
 end if;
 return jsonb_build_object('match_catalog',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'artists',(select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by ta.credit_order) from public.track_artists ta join public.artists a on a.id=ta.artist_id where ta.track_id=t.id)) order by t.id) from public.tracks t where matches ? t.id::text),'[]'::jsonb),'reasons',reasons,'matches',matches,'identity',private.import_identity(c),'release_date',c->'release_date','release_precision',c->'release_precision','known_track',m.track_id,'accepted_identity',m.identity);
end $$;
create function public.create_import_plan(p_season uuid,p_run uuid,p_source_version bigint,p_source text,p_market text,p_snapshot text,p_candidates jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.seasons; cfg private.season_sources; c jsonb; ev jsonb; dec jsonb; pos integer:=0; payload jsonb; r private.import_runs; items jsonb:='[]'::jsonb; seen text[]:='{}'::text[]; checksum text;
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
  c:=private.import_candidate(c); ev:=private.import_evidence(p_season,c); dec:=null;
  if c->>'kind'='track' and c->>'id'=any(seen) then ev:=ev||jsonb_build_object('reasons',jsonb_build_array('duplicate_occurrence'));
  else
   select decision into dec from private.import_reviews where season_id=p_season and provider='spotify' and provider_id=c->>'id' and evidence=ev;
   -- Same-run ISRC/title collisions are review signals too.
   if c->>'kind'='track' and exists(select 1 from private.import_items i where i.run_id=p_run and i.candidate->>'id'<>c->>'id' and ((c->>'isrc' is not null and i.candidate->>'isrc'=c->>'isrc') or lower(i.candidate->>'title')=lower(c->>'title'))) then
    ev:=ev||jsonb_build_object('reasons',(ev->'reasons')||'"suspected_match"'::jsonb); dec:=null;
   end if;
   seen:=array_append(seen,c->>'id');
  end if;
  insert into private.import_items(run_id,position,candidate,evidence,decision) values(p_run,pos,c,ev,dec); pos:=pos+1;
 end loop;
 -- Both unmapped sides of a within-scan collision require review before any admission.
 update private.import_items i set evidence=i.evidence||jsonb_build_object('reasons',(i.evidence->'reasons')||'"suspected_match"'::jsonb),decision=null
 where i.run_id=p_run and i.candidate->>'kind'='track' and i.evidence->>'known_track' is null
 and not (i.evidence->'reasons' ? 'suspected_match' or i.evidence->'reasons' ? 'duplicate_occurrence')
 and exists(select 1 from private.import_items j where j.run_id=p_run and j.candidate->>'kind'='track' and j.candidate->>'id'<>i.candidate->>'id'
 and ((i.candidate->>'isrc' is not null and j.candidate->>'isrc'=i.candidate->>'isrc') or lower(regexp_replace(j.candidate->>'title','\s+',' ','g'))=lower(regexp_replace(i.candidate->>'title','\s+',' ','g'))));
 select jsonb_agg(jsonb_build_object('candidate',candidate,'evidence',evidence) order by position) into items from private.import_items where run_id=p_run;
 update private.import_runs set checksum=encode(sha256(convert_to((payload||jsonb_build_object('items',coalesce(items,'[]')))::text,'UTF8')),'hex'),
 status=case when exists(select 1 from private.import_items where run_id=p_run and evidence->'reasons'<>'[]'::jsonb and not (evidence->'reasons' ? 'duplicate_occurrence') and candidate->>'kind'<>'skipped') then 'review-required' else 'complete' end where id=p_run;
 return public.read_import_plan(p_run);
end $$;
create function public.read_import_plan(p_run uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.import_runs; items jsonb;
begin
 select * into r from private.import_runs where id=p_run;
 if not found then raise exception 'import_not_available' using errcode='42501'; end if;
 perform private.import_admin(r.season_id);
 if r.actor_id<>auth.uid() then raise exception 'import_not_available' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('position',position,'candidate',candidate,'evidence',evidence,'decision',decision,'receipt',receipt) order by position),'[]') into items from private.import_items where run_id=p_run;
 return jsonb_build_object('run',r.id,'checksum',r.checksum,'source',r.source_id,'market',r.market,'snapshot',r.snapshot,'mode',r.mode,'status',r.status,'items',items);
end $$;
create function public.review_import_item(p_run uuid,p_checksum text,p_position integer,p_decision jsonb) returns void language plpgsql security definer set search_path='' as $$
declare r private.import_runs; i private.import_items; s public.seasons; target uuid;
begin
 select * into r from private.import_runs where id=p_run;
 if not found then raise exception 'import_not_available' using errcode='42501'; end if;
 s:=private.import_admin(r.season_id);
 if r.actor_id<>auth.uid() then raise exception 'import_not_available' using errcode='42501'; end if;
 if s.state not in ('SETUP','VOTING') then raise exception 'catalog_closed'; end if;
 if r.checksum is distinct from p_checksum then raise exception 'stale_plan'; end if;
 select * into i from private.import_items where run_id=p_run and position=p_position;
 if not found or i.receipt is not null or jsonb_array_length(i.evidence->'reasons')=0 then raise exception 'item_not_reviewable'; end if;
 if jsonb_typeof(p_decision) is distinct from 'object' or p_decision->>'action' is null or p_decision->>'action' not in ('distinct','attach','keep','defer','decline') or length(btrim(coalesce(p_decision->>'reason',''))) not between 1 and 500 or exists(select 1 from jsonb_object_keys(p_decision) k where k not in ('action','reason','target','include_year','same_version')) then raise exception 'invalid_review'; end if;
 if p_decision->>'action' in ('distinct','attach','keep') then
  if i.candidate->>'kind'<>'track' or i.evidence->'reasons' ? 'duplicate_occurrence' then raise exception 'insufficient_identity'; end if;
  if i.evidence->'reasons' ? 'release_year' and p_decision->'include_year' is distinct from 'true'::jsonb then raise exception 'explicit_year_inclusion_required'; end if;
  if i.evidence->'reasons' ? 'material_identity_conflict' and p_decision->>'action'<>'keep' then raise exception 'mapping_reassignment_forbidden'; end if;
  if p_decision->>'action'='attach' then
   target:=(p_decision->>'target')::uuid;
   if p_decision->'same_version' is distinct from 'true'::jsonb or target is null or not (i.evidence->'matches' ? target::text) then raise exception 'same_version_evidence_required'; end if;
   -- Explicit review is still forbidden from collapsing clearly differing versions.
   if (select title from public.tracks where id=target) is distinct from i.candidate->>'title' then raise exception 'version_identity_conflict'; end if;
  end if;
  if p_decision->>'action'='keep' and i.evidence->>'known_track' is null then raise exception 'unknown_mapping'; end if;
 end if;
 insert into private.import_review_events(run_id,position,actor_id,evidence,decision) values(p_run,p_position,auth.uid(),i.evidence,p_decision);
 update private.import_items set decision=p_decision where run_id=p_run and position=p_position;
 insert into private.import_reviews(season_id,provider,provider_id,evidence,decision,actor_id) values(r.season_id,'spotify',coalesce(i.candidate->>'id','position:'||p_position),i.evidence,p_decision,auth.uid()) on conflict(season_id,provider,provider_id,evidence) do update set decision=excluded.decision,actor_id=excluded.actor_id,at=clock_timestamp();
end $$;
create function public.apply_import_item(p_run uuid,p_checksum text,p_position integer) returns jsonb language plpgsql security definer set search_path='' as $$
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
 c:=i.candidate;
 if c->>'kind'<>'track' or i.evidence->'reasons' ? 'duplicate_occurrence' then
  result:=jsonb_build_object('outcome',case when c->>'kind'='skipped' or i.evidence->'reasons' ? 'duplicate_occurrence' then 'skipped' else 'review-required' end);
 elsif i.decision->>'action' in ('defer','decline') then result:=jsonb_build_object('outcome',i.decision->>'action');
 else
  ev:=private.import_evidence(r.season_id,c);
  if i.evidence->'reasons' ? 'suspected_match' and not(ev->'reasons' ? 'suspected_match') and i.evidence->>'known_track' is null
   and exists(select 1 from private.import_items j where j.run_id=p_run and j.candidate->>'kind'='track' and j.candidate->>'id'<>c->>'id'
    and ((c->>'isrc' is not null and j.candidate->>'isrc'=c->>'isrc') or lower(j.candidate->>'title')=lower(c->>'title'))) then
   ev:=ev||jsonb_build_object('reasons',(ev->'reasons')||'"suspected_match"'::jsonb);
  end if;
  -- A concurrent exact admission is safe to reuse, but new contradictions/matches invalidate approval.
  if ev is distinct from i.evidence and not (ev->'reasons'='[]'::jsonb and i.evidence->'reasons'='[]'::jsonb)
   and not (i.decision->>'action'='distinct' and ev->'reasons'=i.evidence->'reasons' and ev->'identity'=i.evidence->'identity' and ev->'release_date' is not distinct from i.evidence->'release_date' and ev->'known_track'='null'::jsonb) then
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
   insert into private.track_providers(provider,provider_id,track_id,identity,observation,selected_artwork) values('spotify',c->>'id',tid,private.import_identity(c),c,case when new_track then c->>'artwork' else null end); new_mapping:=true;
  else
   -- Never overwrite canonical title/credits; curated artwork wins.
   select not artwork_curated and artwork_url is not distinct from m.selected_artwork into refresh_artwork from public.tracks where id=tid;
   update public.tracks set spotify_url=case when spotify_url is null or spotify_url=c->>'url' then c->>'url' else spotify_url end,
    artwork_url=case when refresh_artwork then c->>'artwork' else artwork_url end where id=tid;
   update private.track_providers set observation=c,last_seen=clock_timestamp(),selected_artwork=case when refresh_artwork then c->>'artwork' else m.selected_artwork end where provider='spotify' and provider_id=c->>'id';
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
  result:=jsonb_build_object('outcome',case when not active then 'already-withdrawn' when added=1 then 'added' else 'already-present' end,'track_id',tid,'new_track',new_track,'new_artists',new_artists,'new_mapping',new_mapping);
 end if;
 update private.import_items set receipt=case when result->>'outcome' in ('defer','decline','review-required') then null else result end where run_id=p_run and position=p_position;
 update private.import_runs set mode='apply',status='partial',updated_at=clock_timestamp() where id=p_run;
 return result;
end $$;
create function public.finish_import_run(p_run uuid,p_checksum text,p_interrupted boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.import_runs; done integer; pending integer; held integer;
begin
 select * into r from private.import_runs where id=p_run;
 if not found then raise exception 'import_not_available' using errcode='42501'; end if;
 perform private.import_admin(r.season_id);
 if r.actor_id<>auth.uid() then raise exception 'import_not_available' using errcode='42501'; end if;
 if r.checksum is distinct from p_checksum then raise exception 'stale_plan'; end if;
 select count(*) filter(where receipt->>'outcome' in ('added','already-present','already-withdrawn')),count(*) filter(where receipt is null and (evidence->'reasons'='[]'::jsonb or decision->>'action' in ('distinct','attach','keep'))),count(*) filter(where receipt->>'outcome'='review-required' or (receipt is null and evidence->'reasons'<>'[]'::jsonb and (decision is null or decision->>'action'='defer'))) into done,pending,held from private.import_items where run_id=p_run;
 update private.import_runs set status=case when p_interrupted then 'interrupted' when pending>0 and done>0 then 'partial' when pending>0 then 'failed' when held>0 then 'review-required' else 'complete' end,updated_at=clock_timestamp() where id=p_run;
 return public.read_import_plan(p_run);
end $$;

revoke all on function private.import_admin(uuid),private.import_identity(jsonb),private.import_candidate(jsonb),private.import_evidence(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.designate_import_source(uuid,text,text,text),public.import_context(uuid),public.create_import_plan(uuid,uuid,bigint,text,text,text,jsonb),public.read_import_plan(uuid),public.review_import_item(uuid,text,integer,jsonb),public.apply_import_item(uuid,text,integer),public.finish_import_run(uuid,text,boolean) from public,anon,service_role;
grant execute on function public.designate_import_source(uuid,text,text,text),public.import_context(uuid),public.create_import_plan(uuid,uuid,bigint,text,text,text,jsonb),public.read_import_plan(uuid),public.review_import_item(uuid,text,integer,jsonb),public.apply_import_item(uuid,text,integer),public.finish_import_run(uuid,text,boolean) to authenticated;
