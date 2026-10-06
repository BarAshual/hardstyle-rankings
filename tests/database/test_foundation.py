"""Real PostgreSQL integration tests, including independent concurrent sessions.

Run only against the disposable local Supabase database after `supabase db reset`.
Connections use postgres solely to emulate PostgREST's SET ROLE + signed JWT claims.
Each application assertion executes as authenticated/anon, never as the owner.
"""
import concurrent.futures
import json
import time
import unittest
import uuid

import psycopg
from psycopg import sql
from pathlib import Path

from db_support import DSN, LOCAL, SUITE_LOCK, assume_user, rollback_connection, validate_dsn

USERS = [str(uuid.UUID(int=i)) for i in range(1, 6)]
ADMIN, MEMBER, SECOND, OUTSIDER, UNVERIFIED = USERS


def connect(user=None, role='authenticated', name='foundation-test'):
    c = psycopg.connect(DSN, application_name=name)
    try:
        c.execute("set statement_timeout='10s'")
        c.execute("set lock_timeout='5s'")
        if user is not None or role == 'anon':
            c.execute(sql.SQL('set local role {}').format(sql.Identifier(role)))
            c.execute("select set_config('request.jwt.claims',%s,true)",
                      (json.dumps({'sub': user, 'role': role, 'app_metadata': {'provider': 'google'}}),))
        return c
    except BaseException:
        c.close()
        raise



def rpc(c, name, *args):
    q = sql.SQL('select public.{}({})').format(sql.Identifier(name), sql.SQL(',').join(sql.Placeholder() for _ in args))
    return c.execute(q, args).fetchone()[0]


def call(user, name, *args):
    with connect(user) as c:
        return rpc(c, name, *args)


def savepoint_rpc(c, name, *args):
    with c.transaction():
        return rpc(c, name, *args)


class Foundation(unittest.TestCase):
    def setUp(self):
        self.sid = call(ADMIN, 'create_season', 'Integration ' + str(uuid.uuid4()), 2026, 1, 'Admin')
        for user in (MEMBER, SECOND):
            n = USERS.index(user) + 1
            inv = call(ADMIN, 'invite_member', self.sid, ' FIXTURE%d@EXAMPLE.INVALID ' % n)
            call(user, 'accept_invitation', inv, 'Member %d' % n)
        self.tracks = [call(ADMIN, 'add_track', self.sid, 'Synthetic %d' % n, ['Synthetic artist']) for n in range(3)]
        call(ADMIN, 'transition_season', self.sid, 'VOTING')

    def vote(self, user=MEMBER, track=0, choice='LIKE', version=0, action=None):
        return call(user, 'cast_vote', self.sid, self.tracks[track], choice, version, action or uuid.uuid4())

    def error(self, message, fn, *args):
        with self.assertRaises(psycopg.Error) as ctx:
            fn(*args)
        self.assertEqual(ctx.exception.diag.message_primary, message)

    def owner_scalar(self, query, params=()):
        with connect() as c:
            return c.execute(query, params).fetchone()[0]

    def test_first_edit_stale_and_same_choice(self):
        self.assertEqual(self.vote()['version'], 1)
        self.error('vote_version_conflict', self.vote)
        self.assertEqual(self.vote(choice='PASS', version=1)['version'], 2)
        self.error('vote_version_conflict', self.vote, MEMBER, 0, 'SUPER_LIKE', 1)
        self.assertEqual(self.vote(choice='PASS', version=2)['version'], 3)
        self.assertEqual(self.owner_scalar('select count(*) from public.vote_events where season_id=%s', (self.sid,)), 3)

    def test_idempotency_lost_response_and_original_outcome(self):
        action = uuid.uuid4()
        first = self.vote(action=action)
        # A fresh connection represents a client that never received the first response.
        self.assertEqual(self.vote(action=action), first)
        self.vote(choice='PASS', version=1)
        self.assertEqual(self.vote(action=action), first)
        call(ADMIN, 'transition_season', self.sid, 'LOCKED')
        self.assertEqual(self.vote(action=action), first)
        self.assertEqual(self.owner_scalar('select count(*) from public.vote_events where season_id=%s', (self.sid,)), 2)

    def test_conflicting_uuid_every_payload_field(self):
        action = uuid.uuid4()
        self.vote(action=action)
        for track, choice, version in [(1, 'LIKE', 0), (0, 'PASS', 0), (0, 'LIKE', 1)]:
            self.error('action_payload_conflict', self.vote, MEMBER, track, choice, version, action)
        other = call(ADMIN, 'create_season', 'Other', 2027, 1, 'Admin')
        self.error('action_payload_conflict', call, MEMBER, 'cast_vote', other, self.tracks[0], 'LIKE', 0, action)
        # UUID namespaces are per actor: another member's action cannot be inspected or blocked.
        self.assertEqual(self.vote(SECOND, action=action)['version'], 1)

    def test_invalid_vote_payload_and_catalog(self):
        for choice, version, action in [('BAD', 0, uuid.uuid4()), ('LIKE', -1, uuid.uuid4()), (None, 0, uuid.uuid4()), ('LIKE', 0, None)]:
            self.error('invalid_vote_payload', call, MEMBER, 'cast_vote', self.sid, self.tracks[0], choice, version, action)
        self.error('track_not_active', call, MEMBER, 'cast_vote', self.sid, uuid.uuid4(), 'LIKE', 0, uuid.uuid4())
        with connect() as c:
            c.execute('update public.season_tracks set active=false where season_id=%s and track_id=%s', (self.sid, self.tracks[2]))
        self.error('track_not_active', self.vote, MEMBER, 2)

    def test_membership_authority_and_season_scoping(self):
        self.error('season_membership_required', self.vote, OUTSIDER)
        self.error('season_admin_required', call, MEMBER, 'invite_member', self.sid, 'somebody@example.invalid')
        self.error('season_admin_required', call, MEMBER, 'add_track', self.sid, 'No', [])
        self.error('season_admin_required', call, MEMBER, 'increase_allowance', self.sid, 2, 'No')
        self.error('season_admin_required', call, MEMBER, 'transition_season', self.sid, 'LOCKED')
        self.error('season_admin_required', call, MEMBER, 'admin_progress', self.sid)
        self.error('season_membership_required', call, OUTSIDER, 'my_progress', self.sid)
        sid = call(OUTSIDER, 'create_season', 'Independent', 2026, 0, 'Creator')
        with connect(OUTSIDER) as c:
            self.assertEqual(c.execute('select role from public.season_members where season_id=%s', (sid,)).fetchone()[0], 'admin')
        self.error('season_admin_required', call, OUTSIDER, 'transition_season', self.sid, 'LOCKED')

    def test_invitation_forwarding_metadata_and_verified_email(self):
        sid = call(ADMIN, 'create_season', 'Admission', 2026, 1, 'Admin')
        inv = call(ADMIN, 'invite_member', sid, ' FIXTURE2@EXAMPLE.INVALID ')
        self.assertEqual(inv, call(ADMIN, 'invite_member', sid, 'fixture2@example.invalid'))
        self.error('invitation_not_available', call, OUTSIDER, 'accept_invitation', inv, 'Forged metadata')
        self.error('invitation_not_available', call, MEMBER, 'accept_invitation', uuid.uuid4(), 'Bad token')
        self.error('verified_google_identity_required', call, UNVERIFIED, 'accept_invitation', inv, 'Unverified')
        self.assertEqual(call(MEMBER, 'accept_invitation', inv, 'Joined'), sid)
        self.assertEqual(call(MEMBER, 'accept_invitation', inv, 'Retry'), sid)
        self.assertEqual(self.owner_scalar('select accepted_by::text from public.season_invitations where id=%s', (inv,)), MEMBER)
        # Database identity ownership is checked independently of matching email text.
        with rollback_connection() as c:
            c.execute('update public.season_invitations set accepted_by=%s where id=%s', (ADMIN, inv))
            assume_user(c, MEMBER)
            self.error('invitation_not_available', savepoint_rpc, c, 'accept_invitation', inv, 'Other account')

    def test_no_alias_folding_and_no_user_metadata_identity(self):
        inv = call(ADMIN, 'invite_member', self.sid, 'fixture4+alias@example.invalid')
        self.error('invitation_not_available', call, OUTSIDER, 'accept_invitation', inv, 'Alias')
        self.error('verified_google_identity_required', call, UNVERIFIED, 'create_season', 'No', 2026, 1, 'No')
        with rollback_connection() as c:
            c.execute("update auth.identities set provider='email' where user_id=%s", (OUTSIDER,))
            assume_user(c, OUTSIDER)
            self.error('verified_google_identity_required', savepoint_rpc, c, 'accept_invitation', inv, 'No Google')

    def test_email_normalization_conserves_internal_whitespace_and_aliases(self):
        cases = [
            ('  Mixed@Example.INVALID  ', 'mixed@example.invalid'),
            ('\t\n Mixed@Example.INVALID\r\n\t', 'mixed@example.invalid'),
            ('User.Name+Tag@Gmail.com', 'user.name+tag@gmail.com'),
            (' A B\tC@example.invalid ', 'a b\tc@example.invalid'),
        ]
        with connect() as c:
            for original, expected in cases:
                self.assertEqual(c.execute('select private.normalize_email(%s)', (original,)).fetchone()[0], expected)
        inv = call(ADMIN, 'invite_member', self.sid, '\t\nFIXTURE4@EXAMPLE.INVALID\r\n')
        self.assertEqual(inv, call(ADMIN, 'invite_member', self.sid, ' fixture4@example.invalid '))
        self.assertEqual(call(OUTSIDER, 'accept_invitation', inv, 'Normalized'), self.sid)
        # Dot/plus spelling and internal whitespace remain distinct invitation keys.
        invites = [call(ADMIN, 'invite_member', self.sid, email) for email in
                   ('user.name@gmail.com', 'username@gmail.com', 'user.name+tag@gmail.com', 'user name@gmail.com')]
        self.assertEqual(len(set(invites)), 4)

    def test_auth_email_normalization_uses_the_same_helper(self):
        inv = call(ADMIN, 'invite_member', self.sid, 'fixture4@example.invalid')
        with rollback_connection() as c:
            c.execute('update auth.users set email=%s where id=%s', ('\tFIXTURE4@EXAMPLE.INVALID\n', OUTSIDER))
            c.execute("update auth.identities set identity_data=jsonb_set(identity_data,'{email}',to_jsonb(%s::text)) where user_id=%s",
                      ('\n Fixture4@Example.Invalid\t', OUTSIDER))
            assume_user(c, OUTSIDER)
            self.assertEqual(rpc(c, 'accept_invitation', inv, 'Normalized identity'), self.sid)

    def test_temporary_changes_rollback_on_interruption(self):
        with self.assertRaises(KeyboardInterrupt):
            with rollback_connection() as c:
                c.execute("update auth.identities set provider='email' where user_id=%s", (OUTSIDER,))
                c.execute("create function private.test_cleanup_probe() returns trigger language plpgsql as $$ begin return new; end $$")
                c.execute('create trigger test_cleanup_probe before insert on public.vote_events for each row execute function private.test_cleanup_probe()')
                raise KeyboardInterrupt()
        with connect() as c:
            self.assertEqual(c.execute('select provider from auth.identities where user_id=%s', (OUTSIDER,)).fetchone()[0], 'google')
            self.assertIsNone(c.execute("select to_regprocedure('private.test_cleanup_probe()')").fetchone()[0])
            self.assertEqual(c.execute("select count(*) from pg_trigger where tgname='test_cleanup_probe'").fetchone()[0], 0)

    def test_suite_guard_rejects_wrong_targets_and_parallel_runs(self):
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        params = conninfo_to_dict(LOCAL['DB_URL'])
        for changes in ({'host': 'db.example.invalid'}, {'port': str(int(params['port'])+1)},
                        {'dbname': 'production'}, {'hostaddr': '203.0.113.1'}, {'service': 'remote'}):
            with self.assertRaises(RuntimeError):
                validate_dsn(make_conninfo(**dict(params, **changes)), LOCAL['DB_URL'])
        with connect() as c:
            self.assertFalse(c.execute('select pg_try_advisory_lock(%s,%s)', SUITE_LOCK).fetchone()[0])

    def test_revocations_preserve_unrelated_public_objects(self):
        with rollback_connection() as c:
            c.execute('create table public.test_unrelated_grants(id integer)')
            c.execute('grant select,insert on public.test_unrelated_grants to anon,authenticated')
            c.execute('create function public.test_unrelated_rpc() returns integer language sql as $$ select 1 $$')
            c.execute('grant execute on function public.test_unrelated_rpc() to anon,authenticated')
            migrations = Path(__file__).resolve().parents[2] / 'supabase/migrations'
            for path in sorted(migrations.glob('*.sql')):
                import re
                source = re.sub(r'--[^\n]*', '', path.read_text())
                for statement in source.split(';'):
                    if statement.strip().lower().startswith('revoke '):
                        c.execute(statement)
            for role in ('anon', 'authenticated'):
                for privilege in ('SELECT', 'INSERT'):
                    self.assertTrue(c.execute("select has_table_privilege(%s,'public.test_unrelated_grants',%s)", (role, privilege)).fetchone()[0])
                self.assertTrue(c.execute("select has_function_privilege(%s,'public.test_unrelated_rpc()','EXECUTE')", (role,)).fetchone()[0])

    def test_invitation_inspection_is_private_read_only_and_member_aware(self):
        inv=call(ADMIN,'invite_member',self.sid,'fixture4@example.invalid')
        preview=call(OUTSIDER,'inspect_invitation',inv)
        self.assertEqual(preview['season_id'],str(self.sid))
        self.assertIsNone(preview['nickname'])
        self.assertEqual(set(preview),{'season_id','season_name','year','nickname'})
        self.assertEqual(self.owner_scalar('select count(*) from public.season_members where season_id=%s and user_id=%s',(self.sid,OUTSIDER)),0)
        self.error('invitation_not_available',call,MEMBER,'inspect_invitation',inv)
        self.error('invitation_not_available',call,OUTSIDER,'inspect_invitation',uuid.uuid4())
        self.error('verified_google_identity_required',call,UNVERIFIED,'inspect_invitation',inv)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with connect(role='anon') as c: rpc(c,'inspect_invitation',inv)
        call(OUTSIDER,'accept_invitation',inv,'Returning raver')
        self.assertEqual(call(OUTSIDER,'inspect_invitation',inv)['nickname'],'Returning raver')
        with rollback_connection() as c:
            c.execute('update public.season_invitations set accepted_by=%s where id=%s',(ADMIN,inv))
            assume_user(c,OUTSIDER)
            self.error('invitation_not_available',savepoint_rpc,c,'inspect_invitation',inv)

    def test_direct_writes_denied(self):
        self.vote()
        statements = [
            ("insert into public.votes values (%s,%s,%s,'PASS',1,now())", (self.sid,SECOND,self.tracks[1])),
            ("update public.votes set choice='PASS' where season_id=%s", (self.sid,)),
            ('delete from public.votes where season_id=%s', (self.sid,)),
            ('delete from public.vote_events where season_id=%s', (self.sid,)),
            ("update public.season_members set role='admin' where season_id=%s", (self.sid,)),
            ("insert into public.season_members(season_id,user_id,nickname) values(%s,%s,'Bypass')", (self.sid,OUTSIDER)),
            ('update public.seasons set super_like_allowance=100 where id=%s', (self.sid,)),
            ('delete from public.season_tracks where season_id=%s', (self.sid,)),
        ]
        for user in (MEMBER, ADMIN, OUTSIDER):
            for query, params in statements:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    with connect(user) as c:
                        c.execute(query, params)
        self.assertEqual(self.owner_scalar('select count(*) from public.votes where season_id=%s', (self.sid,)), 1)

    def test_secrecy_in_all_states_and_admin_progress(self):
        self.vote(choice='SUPER_LIKE')
        self.vote(SECOND, track=1, choice='PASS')
        # Test SETUP read policies too; owner-only reset is not an application operation.
        for state in ('SETUP','VOTING','LOCKED','REVEAL'):
            with connect() as c:
                c.execute('update public.seasons set state=%s where id=%s', (state,self.sid))
            for user, expected in [(MEMBER,1),(SECOND,1),(ADMIN,0),(OUTSIDER,0)]:
                with connect(user) as c:
                    for table in ('votes','vote_events'):
                        count = c.execute(sql.SQL('select count(*) from public.{} where season_id=%s').format(sql.Identifier(table)), (self.sid,)).fetchone()[0]
                        self.assertEqual(count, expected)
                        self.assertEqual(c.execute(sql.SQL('select count(*) from public.{} where season_id=%s and user_id<>auth.uid()').format(sql.Identifier(table)), (self.sid,)).fetchone()[0], 0)
                    # Aggregate SQL sees only RLS-visible rows, including for admins.
                    groups = c.execute('select track_id,choice,count(*) from public.votes where season_id=%s group by track_id,choice', (self.sid,)).fetchall()
                    self.assertEqual(len(groups), expected)
            with connect(ADMIN) as c:
                cur = c.execute('select * from public.admin_progress(%s)', (self.sid,))
                self.assertEqual([d.name for d in cur.description], ['user_id','nickname','role','active_tracks','rated','unrated','completion_percent'])
                self.assertEqual(len(cur.fetchall()), 3)
        with connect(OUTSIDER) as c:
            self.assertEqual(c.execute('select count(*) from public.seasons where id=%s', (self.sid,)).fetchone()[0],0)
            self.assertEqual(c.execute('select count(*) from public.tracks where id=any(%s)', (self.tracks,)).fetchone()[0],0)
            self.assertEqual(c.execute('select count(*) from public.season_invitations where season_id=%s', (self.sid,)).fetchone()[0],0)

    def test_anonymous_and_private_helpers_denied(self):
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with connect(role='anon') as c:
                rpc(c,'cast_vote',self.sid,self.tracks[0],'LIKE',0,uuid.uuid4())
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with connect(MEMBER) as c:
                c.execute('select private.google_email()')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with connect(role='anon') as c:
                c.execute('select * from public.votes')

    def test_super_like_derived_usage_and_increase_audit(self):
        self.vote(choice='SUPER_LIKE')
        self.error('super_like_limit', self.vote, MEMBER, 1, 'SUPER_LIKE')
        progress = call(MEMBER,'my_progress',self.sid)
        self.assertEqual((progress['super_likes_used'],progress['super_likes_available']), (1,0))
        self.vote(choice='LIKE',version=1)
        self.assertEqual(call(MEMBER,'my_progress',self.sid)['super_likes_available'],1)
        self.vote(track=1,choice='SUPER_LIKE')
        self.error('allowance_must_increase',call,ADMIN,'increase_allowance',self.sid,0,'Decrease')
        self.error('allowance_must_increase',call,ADMIN,'increase_allowance',self.sid,1,'Equal')
        self.assertEqual(call(ADMIN,'increase_allowance',self.sid,2,'Late releases'),2)
        self.assertEqual(call(MEMBER,'my_progress',self.sid)['super_likes_used'],1)
        self.vote(track=2,choice='SUPER_LIKE')
        self.assertEqual(call(MEMBER,'my_progress',self.sid)['super_likes_available'],0)
        with connect(ADMIN) as c:
            row = c.execute('select actor_id::text,old_allowance,new_allowance,reason from public.season_config_events where season_id=%s', (self.sid,)).fetchone()
            self.assertEqual(row,(ADMIN,1,2,'Late releases'))
        with self.assertRaises(psycopg.errors.CheckViolation):
            call(ADMIN,'increase_allowance',self.sid,3,' ')
        self.assertEqual(self.owner_scalar('select super_like_allowance from public.seasons where id=%s',(self.sid,)),2)

    def test_growth_preserves_votes_and_completion(self):
        for i in range(3): self.vote(track=i)
        with connect(MEMBER) as c:
            before=c.execute('select * from public.votes where season_id=%s order by track_id',(self.sid,)).fetchall()
        self.assertEqual(call(MEMBER,'my_progress',self.sid)['completion_percent'],100)
        tid=call(ADMIN,'add_track',self.sid,'Late release',['Late artist'])
        progress=call(MEMBER,'my_progress',self.sid)
        self.assertEqual((progress['rated'],progress['unrated'],progress['completion_percent']),(3,1,75))
        self.assertEqual(call(SECOND,'my_progress',self.sid)['unrated'],4)
        with connect(MEMBER) as c:
            self.assertEqual(c.execute('select * from public.votes where season_id=%s order by track_id',(self.sid,)).fetchall(),before)
            unrated=c.execute('select st.track_id from public.season_tracks st where season_id=%s and active and not exists(select 1 from public.votes v where v.season_id=st.season_id and v.track_id=st.track_id and v.user_id=auth.uid())',(self.sid,)).fetchall()
            self.assertEqual(unrated,[(tid,)])
        self.assertEqual(self.owner_scalar('select count(*) from public.vote_events where season_id=%s',(self.sid,)),3)

    def test_lifecycle_order_and_closed_writes(self):
        self.error('invalid_transition',call,ADMIN,'transition_season',self.sid,'REVEAL')
        self.error('invalid_transition',call,ADMIN,'transition_season',self.sid,'SETUP')
        self.vote()
        call(ADMIN,'transition_season',self.sid,'LOCKED')
        self.error('voting_closed',self.vote,MEMBER,1)
        self.error('voting_closed',call,ADMIN,'increase_allowance',self.sid,2,'No')
        self.error('catalog_closed',call,ADMIN,'add_track',self.sid,'No',[])
        call(ADMIN,'transition_season',self.sid,'REVEAL')
        self.error('voting_closed',self.vote,MEMBER,1)
        self.assertEqual(self.owner_scalar('select count(*) from public.season_lifecycle_events where season_id=%s',(self.sid,)),3)

    def test_rollback_between_vote_and_audit_and_failed_action_retry(self):
        action=uuid.uuid4()
        # Transactional DDL is invisible to other sessions and disappears on rollback
        # or connection loss, rather than depending on a later committed DROP.
        with rollback_connection() as c:
            c.execute("""create function private.test_event_failure() returns trigger language plpgsql as $$
            begin raise exception 'injected_event_failure'; end $$""")
            c.execute('create trigger test_event_failure before insert on public.vote_events for each row execute function private.test_event_failure()')
            assume_user(c, MEMBER)
            self.error('injected_event_failure', savepoint_rpc, c, 'cast_vote', self.sid, self.tracks[0], 'LIKE', 0, action)
            for table in ('votes', 'vote_events'):
                self.assertEqual(c.execute('select count(*) from public.'+table+' where season_id=%s', (self.sid,)).fetchone()[0], 0)
        for table in ('votes','vote_events'):
            self.assertEqual(self.owner_scalar('select count(*) from public.'+table+' where season_id=%s',(self.sid,)),0)
        self.assertEqual(self.vote(action=action)['version'],1)

    def test_immutable_history_and_commit_time_consistency(self):
        self.vote()
        for table in ('vote_events','season_lifecycle_events'):
            with self.assertRaisesRegex(psycopg.Error,'immutable_event'):
                with connect() as c: c.execute('delete from public.'+table+' where season_id=%s',(self.sid,))
        c=connect()
        try:
            c.execute("update public.votes set choice='PASS' where season_id=%s",(self.sid,))
            with self.assertRaisesRegex(psycopg.Error,'vote_audit_mismatch'):
                c.commit()
        finally:
            c.close()
        self.assertEqual(self.owner_scalar('select choice from public.votes where season_id=%s',(self.sid,)),'LIKE')

    def concurrent(self, jobs):
        import threading
        barrier=threading.Barrier(len(jobs))
        def run(job):
            barrier.wait(timeout=5)
            try: return ('ok',job())
            except psycopg.Error as e: return ('error',e.diag.message_primary)
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            return list(pool.map(run,jobs))

    def test_concurrent_edits(self):
        self.vote()
        results=self.concurrent([lambda:self.vote(choice='PASS',version=1),lambda:self.vote(choice='SUPER_LIKE',version=1)])
        self.assertEqual(sorted(r[0] for r in results),['error','ok'])
        self.assertIn(('error','vote_version_conflict'),results)
        self.assertEqual(self.owner_scalar('select version from public.votes where season_id=%s',(self.sid,)),2)

    def test_concurrent_super_likes(self):
        results=self.concurrent([lambda:self.vote(track=0,choice='SUPER_LIKE'),lambda:self.vote(track=1,choice='SUPER_LIKE')])
        self.assertEqual(sorted(r[0] for r in results),['error','ok'])
        self.assertIn(('error','super_like_limit'),results)
        self.assertEqual(call(MEMBER,'my_progress',self.sid)['super_likes_used'],1)

    def test_concurrent_duplicate_and_conflicting_actions(self):
        action=uuid.uuid4()
        results=self.concurrent([lambda:self.vote(action=action),lambda:self.vote(action=action)])
        self.assertEqual(results[0],results[1])
        self.assertEqual(results[0][0],'ok')
        other=uuid.uuid4()
        results=self.concurrent([lambda:self.vote(track=1,action=other),lambda:self.vote(track=2,action=other)])
        self.assertEqual(sorted(r[0] for r in results),['error','ok'])
        self.assertIn(('error','action_payload_conflict'),results)

    def wait_until_blocked(self,name):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            with connect() as c:
                if c.execute("select exists(select 1 from pg_stat_activity where application_name=%s and wait_event_type='Lock')",(name,)).fetchone()[0]:
                    return
            time.sleep(.02)
        self.fail('Concurrent transaction did not reach the expected database lock')

    def test_vote_first_lock_waits_until_vote_commit(self):
        holder=connect(MEMBER)
        self.addCleanup(holder.close)
        rpc(holder,'cast_vote',self.sid,self.tracks[0],'LIKE',0,uuid.uuid4())
        name='lock-racer-'+str(uuid.uuid4())
        def lock():
            with connect(ADMIN,name=name) as c: return rpc(c,'transition_season',self.sid,'LOCKED')
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(lock)
            try:
                self.wait_until_blocked(name)
                self.assertFalse(future.done())
                holder.commit()
            finally:
                holder.close()
            self.assertEqual(future.result(timeout=10),'LOCKED')
        self.assertEqual(self.owner_scalar('select count(*) from public.votes where season_id=%s',(self.sid,)),1)
        self.error('voting_closed',self.vote,MEMBER,1)

    def test_lock_first_waiting_vote_fails_after_transition(self):
        holder=connect(ADMIN)
        self.addCleanup(holder.close)
        rpc(holder,'transition_season',self.sid,'LOCKED')
        name='vote-racer-'+str(uuid.uuid4())
        def vote():
            try:
                with connect(MEMBER,name=name) as c: return rpc(c,'cast_vote',self.sid,self.tracks[0],'LIKE',0,uuid.uuid4())
            except psycopg.Error as e: return e.diag.message_primary
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(vote)
            try:
                self.wait_until_blocked(name)
                self.assertFalse(future.done())
                holder.commit()
            finally:
                holder.close()
            self.assertEqual(future.result(timeout=10),'voting_closed')
        self.assertEqual(self.owner_scalar('select count(*) from public.votes where season_id=%s',(self.sid,)),0)

    def test_repeatable_read_cannot_bypass_concurrent_allowance_checks(self):
        c=psycopg.connect(DSN)
        try:
            c.execute('begin isolation level repeatable read')
            c.execute('set local role authenticated')
            c.execute("select set_config('request.jwt.claims',%s,true)",(json.dumps({'sub':MEMBER,'role':'authenticated'}),))
            self.error('read_committed_required',rpc,c,'cast_vote',self.sid,self.tracks[0],'LIKE',0,uuid.uuid4())
        finally:
            c.close()

    def test_constraints_reject_invalid_source_data(self):
        self.vote()
        statements=[
            ("update public.votes set choice='INVALID' where season_id=%s",(self.sid,)),
            ("update public.votes set version=0 where season_id=%s",(self.sid,)),
            ("update public.seasons set super_like_allowance=-1 where id=%s",(self.sid,)),
            ("update public.seasons set state='INVALID' where id=%s",(self.sid,)),
            ("update public.season_members set role='owner' where season_id=%s",(self.sid,)),
            ("insert into public.votes values(%s,%s,%s,'LIKE',1,now())",(self.sid,MEMBER,self.tracks[0])),
            ("insert into public.votes values(%s,%s,%s,'LIKE',1,now())",(self.sid,OUTSIDER,self.tracks[1])),
            ("insert into public.votes values(%s,%s,%s,'LIKE',1,now())",(self.sid,MEMBER,uuid.uuid4())),
            ("delete from public.season_tracks where season_id=%s and track_id=%s",(self.sid,self.tracks[0])),
        ]
        for query,params in statements:
            with self.assertRaises(psycopg.IntegrityError):
                with connect() as c: c.execute(query,params)

    def test_empty_catalog_and_setup_vote_rejection(self):
        sid=call(ADMIN,'create_season','Empty',2026,0,'Admin')
        progress=call(ADMIN,'my_progress',sid)
        self.assertEqual((progress['active_tracks'],progress['rated'],progress['unrated']),(0,0,0))
        self.assertIsNone(progress['completion_percent'])
        track=call(ADMIN,'add_track',sid,'Setup track',[])
        self.error('voting_closed',call,ADMIN,'cast_vote',sid,track,'PASS',0,uuid.uuid4())
        call(ADMIN,'transition_season',sid,'VOTING')
        self.error('super_like_limit',call,ADMIN,'cast_vote',sid,track,'SUPER_LIKE',0,uuid.uuid4())

    def test_existing_track_addition_and_private_catalog_boundary(self):
        sid=call(OUTSIDER,'create_season','Other catalog',2026,1,'Other admin')
        self.error('track_not_available',call,OUTSIDER,'add_existing_track',sid,self.tracks[0])
        sid=call(ADMIN,'create_season','Reuse catalog',2027,1,'Admin')
        call(ADMIN,'add_existing_track',sid,self.tracks[0])
        call(ADMIN,'add_existing_track',sid,self.tracks[0])
        self.assertEqual(call(ADMIN,'my_progress',sid)['active_tracks'],1)

    def test_schema_privileges_and_no_realtime_publication(self):
        with connect() as c:
            tables=c.execute("select tablename from pg_tables where schemaname='public'").fetchall()
            for (table,) in tables:
                for role in ('anon','authenticated'):
                    self.assertFalse(c.execute("select has_table_privilege(%s,%s,'INSERT,UPDATE,DELETE,TRUNCATE')",(role,'public.'+table)).fetchone()[0])
            self.assertEqual(c.execute("select count(*) from pg_publication_tables where schemaname='public' and tablename in ('votes','vote_events')").fetchone()[0],0)
            self.assertEqual(c.execute("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and not ('search_path=\"\"'=any(p.proconfig))").fetchone()[0],0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
