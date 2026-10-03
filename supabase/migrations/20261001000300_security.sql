-- RLS remains equally restrictive in every state, including REVEAL.
create policy member_seasons on public.seasons for select to authenticated using(private.is_member(id));
create policy member_members on public.season_members for select to authenticated using(user_id=auth.uid() or private.is_admin(season_id));
create policy admin_invitations on public.season_invitations for select to authenticated using(private.is_admin(season_id));
create policy member_catalog on public.season_tracks for select to authenticated using(private.is_member(season_id));
create policy member_tracks on public.tracks for select to authenticated using(exists(select 1 from public.season_tracks st where st.track_id=id and private.is_member(st.season_id)));
create policy member_credits on public.track_artists for select to authenticated using(exists(select 1 from public.season_tracks st where st.track_id=track_artists.track_id and private.is_member(st.season_id)));
create policy member_artists on public.artists for select to authenticated using(exists(select 1 from public.track_artists ta join public.season_tracks st on st.track_id=ta.track_id where ta.artist_id=artists.id and private.is_member(st.season_id)));
create policy own_votes on public.votes for select to authenticated using(user_id=auth.uid() and private.is_member(season_id));
create policy own_events on public.vote_events for select to authenticated using(user_id=auth.uid() and private.is_member(season_id));
create policy admin_config_events on public.season_config_events for select to authenticated using(private.is_admin(season_id));
create policy admin_lifecycle_events on public.season_lifecycle_events for select to authenticated using(private.is_admin(season_id));
grant select on public.seasons,public.season_members,public.season_invitations,public.season_tracks,public.tracks,public.artists,public.track_artists,public.votes,public.vote_events,public.season_config_events,public.season_lifecycle_events to authenticated;
revoke all on function public.create_season(text,integer,integer,text),public.invite_member(uuid,text),public.accept_invitation(uuid,text),public.add_track(uuid,text,text[]),public.add_existing_track(uuid,uuid),public.transition_season(uuid,text),public.increase_allowance(uuid,integer,text),public.cast_vote(uuid,uuid,text,integer,uuid),public.my_progress(uuid),public.admin_progress(uuid) from public,anon,authenticated;
revoke all on function private.normalize_email(text),private.immutable_event(),private.check_vote_audit(),private.is_member(uuid),private.is_admin(uuid),private.require_user(),private.google_email(),private.lock_admin_season(uuid) from public,anon,authenticated;
grant execute on function private.is_member(uuid),private.is_admin(uuid) to authenticated;
grant execute on function public.create_season(text,integer,integer,text),public.invite_member(uuid,text),public.accept_invitation(uuid,text),public.add_track(uuid,text,text[]),public.add_existing_track(uuid,uuid),public.transition_season(uuid,text),public.increase_allowance(uuid,integer,text),public.cast_vote(uuid,uuid,text,integer,uuid),public.my_progress(uuid),public.admin_progress(uuid) to authenticated;
-- Scope grants to application-owned objects; do not change unrelated objects or
-- schema-wide default privileges. Every future application migration must supply
-- explicit revocations/grants; local API auto-exposure remains disabled in config.
-- Vote rows/events are intentionally not added to supabase_realtime.
