-- Read-only onboarding bridge: only the verified invited identity can inspect it.
-- Acceptance remains exclusively in accept_invitation and revalidates everything.
create function public.inspect_invitation(p_invitation uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare mail text; inv public.season_invitations; result jsonb;
begin
 mail := private.google_email();
 select * into inv from public.season_invitations where id=p_invitation;
 if not found or inv.email <> mail or (inv.accepted_by is not null and inv.accepted_by <> auth.uid()) then
  raise exception using errcode='42501',message='invitation_not_available';
 end if;
 select jsonb_build_object('season_id',s.id,'season_name',s.name,'year',s.year,'nickname',m.nickname)
 into result from public.seasons s left join public.season_members m on m.season_id=s.id and m.user_id=auth.uid()
 where s.id=inv.season_id;
 return result;
end $$;
revoke all on function public.inspect_invitation(uuid) from public,anon,authenticated;
grant execute on function public.inspect_invitation(uuid) to authenticated;
