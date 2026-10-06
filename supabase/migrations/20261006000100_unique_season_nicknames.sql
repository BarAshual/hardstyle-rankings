-- Preserve display casing; normalize only the season-scoped uniqueness key.
-- Fail rather than silently rename members if an existing database has duplicates.
create unique index season_members_nickname_unique
 on public.season_members (season_id, lower(btrim(nickname)));

create or replace function public.accept_invitation(p_invitation uuid,p_nickname text) returns uuid language plpgsql security definer set search_path = '' as $$
declare mail text; inv public.season_invitations; sid uuid; violated_constraint text;
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
 insert into public.season_members(season_id,user_id,nickname) values(sid,auth.uid(),p_nickname) on conflict (season_id,user_id) do nothing;
 update public.season_invitations set accepted_by=auth.uid(),accepted_at=clock_timestamp() where id=p_invitation;
 return sid;
exception when unique_violation then
 get stacked diagnostics violated_constraint = CONSTRAINT_NAME;
 if violated_constraint = 'season_members_nickname_unique' then
  raise exception using errcode='23505',message='nickname_unavailable';
 end if;
 raise;
end $$;

revoke all on function public.accept_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.accept_invitation(uuid,text) to authenticated;
