-- Durable source data only. All user-facing writes go through secured RPCs.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
revoke create on schema public from public, anon, authenticated;

-- Trim only surrounding POSIX whitespace, then lowercase. Preserve internal
-- whitespace, dots, and plus aliases. Use the same function at every boundary.
create function private.normalize_email(p_email text) returns text
language sql immutable strict set search_path = '' as $$
 select lower(regexp_replace(p_email, '^[[:space:]]+|[[:space:]]+$', '', 'g'))
$$;

create table public.seasons (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) > 0),
 year integer not null check (year between 2000 and 9999),
 state text not null default 'SETUP' check (state in ('SETUP','VOTING','LOCKED','REVEAL')),
 super_like_allowance integer not null check (super_like_allowance >= 0),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create table public.season_members (
 season_id uuid not null references public.seasons on delete restrict,
 user_id uuid not null references auth.users on delete restrict,
 nickname text not null check (length(btrim(nickname)) between 1 and 80),
 role text not null default 'member' check (role in ('member','admin')),
 joined_at timestamptz not null default clock_timestamp(),
 primary key (season_id,user_id)
);
create index season_members_user on public.season_members(user_id,season_id);
create table public.season_invitations (
 id uuid primary key default gen_random_uuid(),
 season_id uuid not null references public.seasons on delete restrict,
 email text not null check (email = private.normalize_email(email) and email like '%_@_%'),
 invited_by uuid not null references auth.users on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 accepted_by uuid references auth.users on delete restrict,
 accepted_at timestamptz,
 unique (season_id,email),
 check ((accepted_by is null) = (accepted_at is null)),
 foreign key (season_id,accepted_by) references public.season_members on delete restrict
);
create index season_invitations_accepted on public.season_invitations(accepted_by) where accepted_by is not null;
create table public.tracks (
 id uuid primary key default gen_random_uuid(),
 title text not null check (length(btrim(title)) > 0),
 artwork_url text,
 spotify_url text,
 apple_music_url text,
 created_at timestamptz not null default clock_timestamp()
);
create table public.artists (
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) > 0)
);
create table public.track_artists (
 track_id uuid not null references public.tracks on delete restrict,
 artist_id uuid not null references public.artists on delete restrict,
 credit_order integer not null check (credit_order >= 0),
 primary key(track_id,artist_id),
 unique(track_id,credit_order)
);
create index track_artists_artist on public.track_artists(artist_id);
create table public.season_tracks (
 season_id uuid not null references public.seasons on delete restrict,
 track_id uuid not null references public.tracks on delete restrict,
 active boolean not null default true,
 added_by uuid not null references auth.users on delete restrict,
 added_at timestamptz not null default clock_timestamp(),
 primary key(season_id,track_id)
);
create index season_tracks_track on public.season_tracks(track_id);
create table public.votes (
 season_id uuid not null,
 user_id uuid not null,
 track_id uuid not null,
 choice text not null check(choice in ('PASS','LIKE','SUPER_LIKE')),
 version integer not null check(version > 0),
 updated_at timestamptz not null,
 primary key(season_id,user_id,track_id),
 foreign key(season_id,user_id) references public.season_members on delete restrict,
 foreign key(season_id,track_id) references public.season_tracks on delete restrict
);
create index votes_super_likes on public.votes(season_id,user_id) where choice = 'SUPER_LIKE';
create index votes_catalog on public.votes(season_id,track_id);
create table public.vote_events (
 user_id uuid not null,
 action_id uuid not null,
 season_id uuid not null,
 track_id uuid not null,
 expected_version integer not null check(expected_version >= 0),
 version integer not null check(version = expected_version + 1),
 previous_choice text check(previous_choice in ('PASS','LIKE','SUPER_LIKE')),
 choice text not null check(choice in ('PASS','LIKE','SUPER_LIKE')),
 accepted_at timestamptz not null,
 primary key(user_id,action_id),
 unique(season_id,user_id,track_id,version),
 check ((expected_version = 0) = (previous_choice is null)),
 foreign key(season_id,user_id,track_id) references public.votes on delete restrict
);
create table public.season_config_events (
 id uuid primary key default gen_random_uuid(),
 season_id uuid not null references public.seasons on delete restrict,
 actor_id uuid not null references auth.users on delete restrict,
 old_allowance integer not null check(old_allowance >= 0),
 new_allowance integer not null check(new_allowance > old_allowance),
 reason text not null check(length(btrim(reason)) > 0),
 changed_at timestamptz not null default clock_timestamp()
);
create index season_config_events_season on public.season_config_events(season_id,changed_at);
create table public.season_lifecycle_events (
 id uuid primary key default gen_random_uuid(),
 season_id uuid not null references public.seasons on delete restrict,
 actor_id uuid not null references auth.users on delete restrict,
 old_state text not null,
 new_state text not null,
 changed_at timestamptz not null default clock_timestamp(),
 check ((old_state,new_state) in (('SETUP','VOTING'),('VOTING','LOCKED'),('LOCKED','REVEAL')))
);
create index season_lifecycle_events_season on public.season_lifecycle_events(season_id,changed_at);

create function private.immutable_event() returns trigger language plpgsql set search_path = '' as $$
begin raise exception using errcode='P0001', message='immutable_event'; end $$;
create trigger vote_events_immutable before update or delete or truncate on public.vote_events for each statement execute function private.immutable_event();
create trigger config_events_immutable before update or delete or truncate on public.season_config_events for each statement execute function private.immutable_event();
create trigger lifecycle_events_immutable before update or delete or truncate on public.season_lifecycle_events for each statement execute function private.immutable_event();

-- Check the final transaction state, not an intermediate state between the two writes.
create function private.check_vote_audit() returns trigger language plpgsql security definer set search_path = '' as $$
declare v public.votes; e public.vote_events; n bigint;
begin
 select * into v from public.votes where season_id=new.season_id and user_id=new.user_id and track_id=new.track_id;
 select * into e from public.vote_events where season_id=v.season_id and user_id=v.user_id and track_id=v.track_id order by version desc limit 1;
 select count(*) into n from public.vote_events where season_id=v.season_id and user_id=v.user_id and track_id=v.track_id;
 if e.version is distinct from v.version or e.choice is distinct from v.choice or e.accepted_at is distinct from v.updated_at or n <> v.version then
  raise exception using errcode='23514',message='vote_audit_mismatch';
 end if;
 return null;
end $$;
create constraint trigger votes_audit_consistent after insert or update on public.votes deferrable initially deferred for each row execute function private.check_vote_audit();
create constraint trigger events_vote_consistent after insert on public.vote_events deferrable initially deferred for each row execute function private.check_vote_audit();

-- No browser writes, even if a permissive RLS policy is added accidentally later.
revoke all on table public.seasons, public.season_members, public.season_invitations, public.tracks, public.artists, public.track_artists, public.season_tracks, public.votes, public.vote_events, public.season_config_events, public.season_lifecycle_events from public, anon, authenticated;
alter table public.seasons enable row level security;
alter table public.season_members enable row level security;
alter table public.season_invitations enable row level security;
alter table public.tracks enable row level security;
alter table public.artists enable row level security;
alter table public.track_artists enable row level security;
alter table public.season_tracks enable row level security;
alter table public.votes enable row level security;
alter table public.vote_events enable row level security;
alter table public.season_config_events enable row level security;
alter table public.season_lifecycle_events enable row level security;
revoke all on function private.normalize_email(text), private.immutable_event(), private.check_vote_audit() from public, anon, authenticated;
