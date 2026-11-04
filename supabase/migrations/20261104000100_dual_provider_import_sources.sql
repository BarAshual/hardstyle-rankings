alter table private.season_sources add column if not exists apple_source_id text;
alter table private.season_sources add column if not exists apple_version bigint;

create function public.designate_import_sources(
  p_season uuid, p_spotify_source text, p_apple_source text, p_market text, p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.seasons; old jsonb; result jsonb;
begin
 s:=private.import_admin(p_season);
 if s.state not in ('SETUP','VOTING') then raise exception 'catalog_closed'; end if;
 if p_spotify_source !~ '^[A-Za-z0-9]{22}$' then raise exception 'invalid_spotify_source' using errcode='22023'; end if;
 if length(btrim(coalesce(p_apple_source,''))) not between 1 and 500 then raise exception 'invalid_apple_source' using errcode='22023'; end if;
 if length(btrim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'invalid_source_reason' using errcode='22023'; end if;
 select to_jsonb(c) into old from private.season_sources c where season_id=p_season;
 insert into private.season_sources(season_id,source_id,market,version,apple_source_id,apple_version)
 values(p_season,p_spotify_source,coalesce(p_market,'IL'),1,p_apple_source,1)
 on conflict(season_id) do update set source_id=excluded.source_id,market=excluded.market,
   version=private.season_sources.version+1,apple_source_id=excluded.apple_source_id,
   apple_version=coalesce(private.season_sources.apple_version,0)+1;
 select to_jsonb(c) into result from private.season_sources c where season_id=p_season;
 insert into private.source_events(season_id,actor_id,before_config,after_config,reason)
 values(p_season,auth.uid(),old,result,p_reason);
 return result;
end $$;
grant execute on function public.designate_import_sources(uuid,text,text,text,text) to authenticated;
