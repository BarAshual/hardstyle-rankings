-- Personal queue derived from active catalog and persisted votes, never an index.
create function public.next_unrated_track(p_season uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid; result jsonb;
begin
 u := private.require_user();
 if not private.is_member(p_season) then
  raise exception using errcode='42501',message='season_membership_required';
 end if;
 select jsonb_build_object(
  'id', t.id, 'title', t.title, 'artwork_url', t.artwork_url,
  'spotify_url', t.spotify_url, 'apple_music_url', t.apple_music_url,
  'artists', coalesce((select jsonb_agg(a.name order by ta.credit_order)
   from public.track_artists ta join public.artists a on a.id=ta.artist_id
   where ta.track_id=t.id), '[]'::jsonb)
 ) into result
 from public.season_tracks st join public.tracks t on t.id=st.track_id
 where st.season_id=p_season and st.active
 and not exists(select 1 from public.votes v
  where v.season_id=p_season and v.user_id=u and v.track_id=t.id)
 order by md5(u::text || ':' || p_season::text || ':' || t.id::text), t.id
 limit 1;
 return result;
end $$;
revoke all on function public.next_unrated_track(uuid) from public,anon,authenticated;
grant execute on function public.next_unrated_track(uuid) to authenticated;
