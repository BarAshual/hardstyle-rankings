-- Audited listening-link curation; canonical identities and voting rows are untouched.
create table private.track_link_events (
 id uuid primary key default gen_random_uuid(),
 season_id uuid not null references public.seasons,
 track_id uuid not null references public.tracks,
 actor_id uuid not null references auth.users,
 before_url text, after_url text not null,
 reason text not null check(length(btrim(reason)) between 1 and 500),
 at timestamptz not null default clock_timestamp()
);
alter table private.track_link_events enable row level security;
revoke all on private.track_link_events from public,anon,authenticated,service_role;
create trigger track_link_events_immutable before update or delete or truncate on private.track_link_events
for each statement execute function private.immutable_event();

create function public.set_reviewed_apple_link(p_season uuid,p_track uuid,p_expected_url text,p_url text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.seasons; current_url text;
begin
 s:=private.import_admin(p_season);
 if s.state not in ('SETUP','VOTING') then raise exception 'catalog_closed'; end if;
 if p_url is null or length(p_url)>500 or p_url !~ '^https://music[.]apple[.]com/[a-z]{2}/(song/[a-zA-Z0-9%._~-]+/[0-9]+|album/[a-zA-Z0-9%._~-]+/[0-9]+[?]i=[0-9]+)$' then
  raise exception 'invalid_apple_link' using errcode='22023';
 end if;
 if length(btrim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'review_reason_required'; end if;
 if not exists(select 1 from public.season_tracks where season_id=p_season and track_id=p_track and active) then
  raise exception 'track_not_available' using errcode='42501';
 end if;
 select apple_music_url into current_url from public.tracks where id=p_track for update;
 -- Equal desired value is a safe retry; it creates no duplicate audit event.
 if current_url is not distinct from p_url then return jsonb_build_object('status','already_present','track_id',p_track); end if;
 if current_url is distinct from p_expected_url then raise exception 'link_changed'; end if;
 update public.tracks set apple_music_url=p_url where id=p_track;
 insert into private.track_link_events(season_id,track_id,actor_id,before_url,after_url,reason)
 values(p_season,p_track,auth.uid(),current_url,p_url,p_reason);
 return jsonb_build_object('status','updated','track_id',p_track);
end $$;
revoke all on function public.set_reviewed_apple_link(uuid,uuid,text,text,text) from public,anon,service_role;
grant execute on function public.set_reviewed_apple_link(uuid,uuid,text,text,text) to authenticated;
