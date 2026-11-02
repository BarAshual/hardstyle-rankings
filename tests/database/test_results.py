"""Real local PostgreSQL and PostgREST coverage for the bounded results contract.

All identities, seasons, tracks and ballots are synthetic. db_support retains the
existing local-project fingerprint and process-wide lock before any test connects.
"""
import concurrent.futures
import json
import unittest
import urllib.request
import uuid

import psycopg
from psycopg import sql

from db_support import assume_user, rollback_connection
from test_foundation import (
    ADMIN, MEMBER, SECOND, OUTSIDER, call, connect, rpc, savepoint_rpc,
)
import test_foundation as foundation
import test_http as http


CATEGORY = 'love_similarity'
READ = 'get_love_similarity_results'
GET = 'get_love_similarity_visibility'
SET = 'set_love_similarity_visibility'
COUNTS = {
    'coRatedCount', 'loveIntersectionCount', 'loveUnionCount',
    'slIntersectionCount', 'slUnionCount',
}


class ResultsFixture:
    # Borrow helpers rather than inheriting Foundation/DataAPI and rediscovering
    # all their tests under a second class.
    error = foundation.Foundation.error
    owner_scalar = foundation.Foundation.owner_scalar
    wait_until_blocked = foundation.Foundation.wait_until_blocked
    concurrent = foundation.Foundation.concurrent

    def setUp(self):
        self.sid = self.season('Results synthetic official')

    def season(self, title, admin=ADMIN, members=(MEMBER, SECOND)):
        sid = call(admin, 'create_season', title + ' ' + str(uuid.uuid4()), 2026, 10, 'Admin')
        for user in members:
            invitation = call(admin, 'invite_member', sid, 'fixture%d@example.invalid' % int(uuid.UUID(user)))
            call(user, 'accept_invitation', invitation, 'Member %d' % int(uuid.UUID(user)))
        return sid

    def reveal(self, sid=None, state='SETUP', admin=ADMIN):
        sid = self.sid if sid is None else sid
        states = ('SETUP', 'VOTING', 'LOCKED', 'REVEAL')
        for next_state in states[states.index(state) + 1:]:
            call(admin, 'transition_season', sid, next_state)

    def set_visible(self, visible=True, action=None, sid=None, user=ADMIN):
        return call(user, SET, self.sid if sid is None else sid, visible, action or uuid.uuid4())

    def event_count(self):
        return self.owner_scalar('select count(*) from private.season_result_category_events where season_id=%s', (self.sid,))

    def assert_envelope(self, result, sid=None):
        self.assertEqual(set(result), {'seasonId', 'algorithm', 'pairs'})
        self.assertEqual(result['seasonId'], str(self.sid if sid is None else sid))
        self.assertEqual(result['algorithm'], 'taste-love-v1')
        identities = []
        for pair in result['pairs']:
            self.assertEqual(set(pair), {'first', 'second'} | COUNTS)
            for member in ('first', 'second'):
                self.assertEqual(set(pair[member]), {'memberId', 'nickname'})
            ids = (pair['first']['memberId'], pair['second']['memberId'])
            self.assertLess(ids[0], ids[1])
            identities.append(ids)
            for field in COUNTS:
                self.assertIs(type(pair[field]), int)
                self.assertGreaterEqual(pair[field], 0)
        self.assertEqual(identities, sorted(set(identities)))

    def synthetic_ballots(self):
        """Same canonical tracks, different current choices/eligibility by season."""
        dummy = self.season('Results synthetic dummy')
        tracks = [call(ADMIN, 'add_track', self.sid, 'Synthetic recording %d' % i, ['Synthetic artist']) for i in range(8)]
        for track in tracks:
            call(ADMIN, 'add_existing_track', dummy, track)
        for sid in (self.sid, dummy):
            call(ADMIN, 'transition_season', sid, 'VOTING')
        choices = {
            ADMIN: ['SUPER_LIKE', 'LIKE', 'SUPER_LIKE', 'PASS', 'SUPER_LIKE', 'SUPER_LIKE', None, 'LIKE'],
            MEMBER: ['SUPER_LIKE', 'SUPER_LIKE', 'SUPER_LIKE', 'PASS', 'SUPER_LIKE', None, 'SUPER_LIKE', 'PASS'],
        }
        for user, ballot in choices.items():
            for track, choice in zip(tracks, ballot):
                if choice is not None:
                    call(user, 'cast_vote', self.sid, track, choice, 0, uuid.uuid4())
            for track in tracks:
                call(user, 'cast_vote', dummy, track, 'LIKE', 0, uuid.uuid4())
        call(ADMIN, 'cast_vote', self.sid, tracks[0], 'PASS', 1, uuid.uuid4())
        # No withdrawal endpoint exists. Owner-only synthetic fixture setup makes
        # one existing association ineligible without changing votes/history.
        with connect() as c:
            c.execute('update public.season_tracks set active=false where season_id=%s and track_id=%s', (self.sid, tracks[4]))
        for sid in (self.sid, dummy):
            self.reveal(sid, state='VOTING')
        return dummy, tracks


class ResultsDatabase(ResultsFixture, unittest.TestCase):
    def test_authorization_all_states_and_transition_does_not_open(self):
        other = self.season('Other-admin synthetic', admin=OUTSIDER, members=())
        for state in ('SETUP', 'VOTING', 'LOCKED', 'REVEAL'):
            if state != 'SETUP':
                call(ADMIN, 'transition_season', self.sid, state)
            metadata = call(ADMIN, GET, self.sid)
            self.assertEqual(metadata, {'seasonId': str(self.sid), 'category': CATEGORY, 'visible': False,
                                        'state': state, 'canChange': state == 'REVEAL'})
            for user in (ADMIN, MEMBER, SECOND):
                self.error('results_not_available', call, user, READ, self.sid)
            for user in (MEMBER, SECOND, OUTSIDER):
                self.error('season_admin_required', call, user, GET, self.sid)
                self.error('season_admin_required', call, user, SET, self.sid, True, uuid.uuid4())
            self.error('season_membership_required', call, OUTSIDER, READ, self.sid)
            self.error('season_membership_required', call, ADMIN, READ, other)
            if state != 'REVEAL':
                for visible in (False, True):
                    self.error('results_require_reveal', call, ADMIN, SET, self.sid, visible, uuid.uuid4())
        self.assertEqual(self.event_count(), 0)
        self.assertEqual(self.owner_scalar('select count(*) from private.season_result_categories where season_id=%s', (self.sid,)), 0)
        self.set_visible()
        for user in (ADMIN, MEMBER, SECOND):
            result = call(user, READ, self.sid)
            self.assert_envelope(result)
            self.assertEqual(len(result['pairs']), 3)
        self.error('season_membership_required', call, OUTSIDER, READ, self.sid)

    def test_lifecycle_is_required_even_if_private_setting_is_true(self):
        for state in ('SETUP', 'VOTING', 'LOCKED'):
            if state != 'SETUP':
                call(ADMIN, 'transition_season', self.sid, state)
            with rollback_connection() as c:
                c.execute('insert into private.season_result_categories(season_id,category,visible) values(%s,%s,true)', (self.sid, CATEGORY))
                for user in (ADMIN, MEMBER):
                    assume_user(c, user)
                    self.error('results_not_available', savepoint_rpc, c, READ, self.sid)
                    c.execute('reset role')

    def test_anonymous_missing_identity_private_tables_and_execute_grants(self):
        functions = [(GET, (self.sid,)), (SET, (self.sid, True, uuid.uuid4())), (READ, (self.sid,))]
        for name, args in functions:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                with connect(role='anon') as c:
                    rpc(c, name, *args)
            with connect(MEMBER) as c:
                c.execute("select set_config('request.jwt.claims','{}',true)")
                self.error('authentication_required', rpc, c, name, *args)
        for user in (ADMIN, MEMBER, OUTSIDER):
            for table in ('season_result_categories', 'season_result_category_events'):
                for statement in ('select * from private.{}', 'delete from private.{}', 'truncate private.{}'):
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        with connect(user) as c:
                            c.execute(sql.SQL(statement).format(sql.Identifier(table)))
        with connect() as c:
            for table in ('season_result_categories', 'season_result_category_events'):
                self.assertTrue(c.execute('select relrowsecurity from pg_class where oid=%s::regclass', ('private.' + table,)).fetchone()[0])
                for role in ('anon', 'authenticated'):
                    for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'):
                        self.assertFalse(c.execute('select has_table_privilege(%s,%s,%s)', (role, 'private.' + table, privilege)).fetchone()[0])

    def test_current_votes_eligible_tracks_and_seasons_remain_separate(self):
        dummy, tracks = self.synthetic_ballots()
        with connect() as c:
            before = c.execute('select * from public.votes where season_id=any(%s) order by season_id,user_id,track_id', ([self.sid, dummy],)).fetchall()
            history = c.execute('select * from public.vote_events where season_id=any(%s) order by season_id,user_id,track_id,version', ([self.sid, dummy],)).fetchall()
        self.set_visible()
        self.error('results_not_available', call, MEMBER, READ, dummy)
        official = call(MEMBER, READ, self.sid)
        self.assert_envelope(official)
        self.assertEqual(len(official['pairs']), 3)
        pair = official['pairs'][0]
        self.assertEqual(pair['first'], {'memberId': ADMIN, 'nickname': 'Admin'})
        self.assertEqual(pair['second'], {'memberId': MEMBER, 'nickname': 'Member 2'})
        self.assertEqual({key: pair[key] for key in COUNTS}, {
            'coRatedCount': 5, 'loveIntersectionCount': 2, 'loveUnionCount': 4,
            'slIntersectionCount': 1, 'slUnionCount': 3,
        })
        for zero in official['pairs'][1:]:
            self.assertEqual({key: zero[key] for key in COUNTS}, dict.fromkeys(COUNTS, 0))
        self.set_visible(sid=dummy)
        dummy_result = call(MEMBER, READ, dummy)
        self.assert_envelope(dummy_result, dummy)
        self.assertEqual({key: dummy_result['pairs'][0][key] for key in COUNTS}, {
            'coRatedCount': 8, 'loveIntersectionCount': 8, 'loveUnionCount': 8,
            'slIntersectionCount': 0, 'slUnionCount': 0,
        })
        self.set_visible(False, sid=dummy)
        self.assertEqual(call(MEMBER, READ, self.sid), official)
        for user in (ADMIN, MEMBER, SECOND):
            with connect(user) as c:
                for table in ('votes', 'vote_events'):
                    self.assertEqual(c.execute(sql.SQL('select count(*) from public.{} where season_id=any(%s) and user_id<>auth.uid()').format(sql.Identifier(table)), ([self.sid, dummy],)).fetchone()[0], 0)
        with connect() as c:
            self.assertEqual(c.execute('select * from public.votes where season_id=any(%s) order by season_id,user_id,track_id', ([self.sid, dummy],)).fetchall(), before)
            self.assertEqual(c.execute('select * from public.vote_events where season_id=any(%s) order by season_id,user_id,track_id,version', ([self.sid, dummy],)).fetchall(), history)
            self.assertEqual(c.execute('select version from public.votes where season_id=%s and user_id=%s and track_id=%s', (self.sid, ADMIN, tracks[0])).fetchone()[0], 2)

    def test_single_member_has_empty_pairs(self):
        solo = self.season('Solo synthetic', members=())
        self.reveal(solo)
        self.set_visible(sid=solo)
        result = call(ADMIN, READ, solo)
        self.assert_envelope(result, solo)
        self.assertEqual(result['pairs'], [])

    def test_audited_toggle_replay_does_not_reapply_and_uuid_conflicts(self):
        self.reveal()
        action = uuid.uuid4()
        first = self.set_visible(action=action)
        self.assertEqual(set(first), {'seasonId', 'category', 'visible', 'actionId', 'changedAt'})
        self.assertEqual({key: first[key] for key in ('seasonId', 'category', 'visible', 'actionId')},
                         {'seasonId': str(self.sid), 'category': CATEGORY, 'visible': True, 'actionId': str(action)})
        same = self.set_visible()
        self.assertTrue(same['visible'])
        hidden = self.set_visible(False)
        self.assertFalse(hidden['visible'])
        self.assertEqual(self.set_visible(action=action), first)
        self.assertFalse(call(ADMIN, GET, self.sid)['visible'])
        self.error('results_not_available', call, MEMBER, READ, self.sid)
        self.error('action_payload_conflict', call, ADMIN, SET, self.sid, False, action)
        other = self.season('Replay other synthetic')
        self.reveal(other)
        self.error('action_payload_conflict', call, ADMIN, SET, other, True, action)
        self.assertEqual(self.event_count(), 3)
        with connect() as c:
            rows = c.execute('select actor_id::text,action_id::text,category,old_visible,new_visible,changed_at from private.season_result_category_events where season_id=%s', (self.sid,)).fetchall()
        events = {row[1]: row for row in rows}
        for receipt, change in zip((first, same, hidden), ((False, True), (True, True), (True, False))):
            row = events[receipt['actionId']]
            self.assertEqual(row[:3], (ADMIN, receipt['actionId'], CATEGORY))
            self.assertEqual(row[3:5], change)
            self.assertIsNotNone(row[5])
        # An action UUID belongs to its actor, not to a global namespace.
        outsider_season = self.season('Independent action owner', admin=OUTSIDER, members=())
        self.reveal(outsider_season, admin=OUTSIDER)
        self.assertTrue(self.set_visible(sid=outsider_season, user=OUTSIDER, action=action)['visible'])

    def test_invalid_payload_and_isolation_do_not_write(self):
        self.reveal()
        for args in ((None, True, uuid.uuid4()), (self.sid, None, uuid.uuid4()), (self.sid, True, None)):
            self.error('invalid_result_visibility_payload', call, ADMIN, SET, *args)
        for level in ('repeatable read', 'serializable'):
            for name, args in ((GET, (self.sid,)), (READ, (self.sid,)), (SET, (self.sid, True, uuid.uuid4()))):
                with connect() as c:
                    c.execute('set transaction isolation level ' + level)
                    assume_user(c, ADMIN)
                    self.error('read_committed_required', rpc, c, name, *args)
        self.assertEqual(self.event_count(), 0)
        self.assertFalse(call(ADMIN, GET, self.sid)['visible'])

    def test_event_failure_rolls_back_setting_and_does_not_reserve_action(self):
        self.reveal()
        for old_visible in (None, True):
            action = uuid.uuid4()
            expected_events = self.event_count()
            with rollback_connection() as c:
                c.execute("""create function private.test_results_event_failure() returns trigger language plpgsql as $$
                begin raise exception 'injected_result_event_failure'; end $$""")
                c.execute('create trigger test_results_event_failure before insert on private.season_result_category_events for each row execute function private.test_results_event_failure()')
                assume_user(c, ADMIN)
                self.error('injected_result_event_failure', savepoint_rpc, c, SET, self.sid, old_visible is None, action)
                c.execute('reset role')
                current = c.execute('select visible from private.season_result_categories where season_id=%s', (self.sid,)).fetchone()
                self.assertEqual(current, None if old_visible is None else (old_visible,))
                self.assertEqual(c.execute('select count(*) from private.season_result_category_events where season_id=%s', (self.sid,)).fetchone()[0], expected_events)
            receipt = self.set_visible(old_visible is None, action=action)
            self.assertEqual(receipt['visible'], old_visible is None)
            self.assertEqual(self.event_count(), expected_events + 1)

    def test_audit_is_immutable_even_to_owner_and_history_restricts_deletion(self):
        self.reveal()
        self.set_visible()
        for statement in (
            'update private.season_result_category_events set new_visible=false where season_id=%s',
            'delete from private.season_result_category_events where season_id=%s',
            'truncate private.season_result_category_events',
        ):
            with self.assertRaisesRegex(psycopg.Error, 'immutable_event'):
                with connect() as c:
                    c.execute(statement, (self.sid,) if '%s' in statement else ())
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            with connect() as c:
                c.execute('delete from public.seasons where id=%s', (self.sid,))
        self.assertEqual(self.event_count(), 1)
        self.assertTrue(call(ADMIN, GET, self.sid)['visible'])

    def test_concurrent_same_and_conflicting_action_ids(self):
        self.reveal()
        action = uuid.uuid4()
        answers = self.concurrent([lambda: self.set_visible(action=action), lambda: self.set_visible(action=action)])
        self.assertEqual(answers[0][0], 'ok')
        self.assertEqual(answers[0], answers[1])
        self.assertEqual(self.event_count(), 1)
        conflict = uuid.uuid4()
        answers = self.concurrent([lambda: self.set_visible(True, action=conflict), lambda: self.set_visible(False, action=conflict)])
        self.assertEqual(sorted(answer[0] for answer in answers), ['error', 'ok'])
        self.assertIn(('error', 'action_payload_conflict'), answers)
        self.assertEqual(self.event_count(), 2)

    def test_hide_first_waiting_result_observes_hidden(self):
        self.reveal()
        self.set_visible()
        holder = connect(ADMIN)
        self.addCleanup(holder.close)
        rpc(holder, SET, self.sid, False, uuid.uuid4())
        name = 'results-hide-first-' + str(uuid.uuid4())
        def read():
            try:
                with connect(MEMBER, name=name) as c:
                    return rpc(c, READ, self.sid)
            except psycopg.Error as error:
                return error.diag.message_primary
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            future = pool.submit(read)
            try:
                self.wait_until_blocked(name)
                self.assertFalse(future.done())
                holder.commit()
            finally:
                holder.close()
            self.assertEqual(future.result(timeout=10), 'results_not_available')

    def test_result_first_hiding_waits_for_result_transaction(self):
        self.reveal()
        self.set_visible()
        holder = connect(MEMBER)
        self.addCleanup(holder.close)
        self.assert_envelope(rpc(holder, READ, self.sid))
        name = 'results-read-first-' + str(uuid.uuid4())
        def hide():
            with connect(ADMIN, name=name) as c:
                return rpc(c, SET, self.sid, False, uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            future = pool.submit(hide)
            try:
                self.wait_until_blocked(name)
                self.assertFalse(future.done())
                holder.commit()
            finally:
                holder.close()
            self.assertFalse(future.result(timeout=10)['visible'])
        self.error('results_not_available', call, MEMBER, READ, self.sid)

    def test_reveal_first_waiting_open_observes_committed_state(self):
        call(ADMIN, 'transition_season', self.sid, 'VOTING')
        call(ADMIN, 'transition_season', self.sid, 'LOCKED')
        holder = connect(ADMIN)
        self.addCleanup(holder.close)
        rpc(holder, 'transition_season', self.sid, 'REVEAL')
        name = 'results-reveal-first-' + str(uuid.uuid4())
        def open_category():
            with connect(ADMIN, name=name) as c:
                return rpc(c, SET, self.sid, True, uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            future = pool.submit(open_category)
            try:
                self.wait_until_blocked(name)
                self.assertFalse(future.done())
                holder.commit()
            finally:
                holder.close()
            self.assertTrue(future.result(timeout=10)['visible'])
        self.assert_envelope(call(MEMBER, READ, self.sid))

    def test_open_queued_before_reveal_fails_then_same_action_can_retry(self):
        call(ADMIN, 'transition_season', self.sid, 'VOTING')
        call(ADMIN, 'transition_season', self.sid, 'LOCKED')
        # A fixture barrier lets the two actual RPC transactions queue in a
        # controlled order at the shared season row lock, before either proceeds.
        holder = connect()
        self.addCleanup(holder.close)
        holder.execute('select id from public.seasons where id=%s for update', (self.sid,))
        action = uuid.uuid4()
        opener_name = 'results-open-first-' + str(uuid.uuid4())
        revealer_name = 'results-reveal-second-' + str(uuid.uuid4())
        def open_category():
            try:
                with connect(ADMIN, name=opener_name) as c:
                    return rpc(c, SET, self.sid, True, action)
            except psycopg.Error as error:
                return error.diag.message_primary
        def reveal():
            with connect(ADMIN, name=revealer_name) as c:
                return rpc(c, 'transition_season', self.sid, 'REVEAL')
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            opening = pool.submit(open_category)
            try:
                self.wait_until_blocked(opener_name)
                revealing = pool.submit(reveal)
                self.wait_until_blocked(revealer_name)
                holder.commit()
            finally:
                holder.close()
            self.assertEqual(opening.result(timeout=10), 'results_require_reveal')
            self.assertEqual(revealing.result(timeout=10), 'REVEAL')
        self.assertFalse(call(ADMIN, GET, self.sid)['visible'])
        self.assertEqual(self.event_count(), 0)
        self.assertTrue(self.set_visible(action=action)['visible'])

    def test_actor_lock_precedes_season_lock(self):
        self.reveal()
        holder = connect()
        self.addCleanup(holder.close)
        holder.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (ADMIN,))
        name = 'results-actor-lock-' + str(uuid.uuid4())
        def open_category():
            with connect(ADMIN, name=name) as c:
                return rpc(c, SET, self.sid, True, uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            future = pool.submit(open_category)
            try:
                self.wait_until_blocked(name)
                # If the setter had already locked the season, NOWAIT fails.
                holder.execute('select id from public.seasons where id=%s for update nowait', (self.sid,))
                holder.commit()
            finally:
                holder.close()
            self.assertTrue(future.result(timeout=10)['visible'])


class ResultsDataAPI(ResultsFixture, unittest.TestCase):
    setUpClass = classmethod(http.DataAPI.setUpClass.__func__)
    token = http.DataAPI.token
    request = http.DataAPI.request

    def test_http_authorization_all_states_and_hidden_defaults(self):
        self.season('Other admin HTTP synthetic', admin=OUTSIDER, members=())
        body = {'p_season': str(self.sid)}
        for state in ('SETUP', 'VOTING', 'LOCKED', 'REVEAL'):
            if state != 'SETUP':
                call(ADMIN, 'transition_season', self.sid, state)
            status, metadata = self.request(ADMIN, 'rpc/' + GET, body)
            self.assertEqual(status, 200, metadata)
            self.assertEqual(metadata['state'], state)
            self.assertFalse(metadata['visible'])
            for user in (ADMIN, MEMBER, SECOND):
                status, response = self.request(user, 'rpc/' + READ, body)
                self.assertGreaterEqual(status, 400, response)
                self.assertEqual(response['message'], 'results_not_available')
                self.assertIsNone(response['details'])
                self.assertIsNone(response['hint'])
            for user in (MEMBER, SECOND, OUTSIDER):
                for name, payload in ((GET, body), (SET, dict(body, p_visible=True, p_action=str(uuid.uuid4())))):
                    status, response = self.request(user, 'rpc/' + name, payload)
                    self.assertEqual(status, 403, response)
                    self.assertEqual(response['message'], 'season_admin_required')
            self.assertEqual(self.request(OUTSIDER, 'rpc/' + READ, body)[0], 403)
            for name, payload in ((GET, body), (READ, body), (SET, dict(body, p_visible=True, p_action=str(uuid.uuid4())))):
                self.assertIn(self.request(None, 'rpc/' + name, payload)[0], (401, 403))
            if state != 'REVEAL':
                for visible in (False, True):
                    status, response = self.request(ADMIN, 'rpc/' + SET, dict(body, p_visible=visible, p_action=str(uuid.uuid4())))
                    self.assertGreaterEqual(status, 400, response)
                    self.assertEqual(response['message'], 'results_require_reveal')
        self.assertEqual(self.event_count(), 0)
        action = str(uuid.uuid4())
        payload = dict(body, p_visible=True, p_action=action)
        status, receipt = self.request(ADMIN, 'rpc/' + SET, payload)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(self.request(ADMIN, 'rpc/' + SET, payload), (200, receipt))
        self.set_visible(False)
        self.assertEqual(self.request(ADMIN, 'rpc/' + SET, payload), (200, receipt))
        self.assertFalse(self.request(ADMIN, 'rpc/' + GET, body)[1]['visible'])
        self.assertEqual(self.request(ADMIN, 'rpc/' + SET, dict(payload, p_visible=False))[1]['message'], 'action_payload_conflict')

    def test_http_narrow_projection_season_isolation_raw_rls_and_no_store(self):
        dummy, _ = self.synthetic_ballots()
        self.set_visible()
        body = {'p_season': str(self.sid)}
        for user in (ADMIN, MEMBER, SECOND):
            status, result = self.request(user, 'rpc/' + READ, body)
            self.assertEqual(status, 200, result)
            self.assert_envelope(result)
            self.assertEqual(result['pairs'][0]['coRatedCount'], 5)
            self.assertEqual(result['pairs'][0]['loveIntersectionCount'], 2)
            # RLS still limits both raw tables to the caller even after opening.
            for table in ('votes', 'vote_events'):
                status, rows = self.request(user, table + '?season_id=eq.' + str(self.sid) + '&user_id=neq.' + user)
                self.assertEqual((status, rows), (200, []))
            for table in ('season_result_categories', 'season_result_category_events'):
                self.assertEqual(self.request(user, table)[0], 404)
        status, result = self.request(MEMBER, 'rpc/' + READ, {'p_season': str(dummy)})
        self.assertGreaterEqual(status, 400)
        self.assertEqual(result['message'], 'results_not_available')
        self.set_visible(sid=dummy)
        dummy_result = self.request(MEMBER, 'rpc/' + READ, {'p_season': str(dummy)})[1]
        self.assertEqual(dummy_result['pairs'][0]['coRatedCount'], 8)
        self.assertEqual(dummy_result['pairs'][0]['slUnionCount'], 0)
        for user in (OUTSIDER, None):
            self.assertIn(self.request(user, 'rpc/' + READ, body)[0], (401, 403))
        # Spoofed user/category selectors are not accepted overloads.
        for extra in ({'p_user_id': ADMIN}, {'p_category': 'other'}):
            self.assertEqual(self.request(MEMBER, 'rpc/' + READ, dict(body, **extra))[0], 404)
        request = urllib.request.Request(self.url + 'rpc/' + READ, data=json.dumps(body).encode(), headers={
            'apikey': self.config['ANON_KEY'], 'Authorization': 'Bearer ' + self.token(MEMBER),
            'Content-Type': 'application/json',
        })
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertIn('no-store', response.headers.get('Cache-Control', ''))
            self.assert_envelope(json.loads(response.read()))
        self.set_visible(False)
        self.assertEqual(self.request(MEMBER, 'rpc/' + READ, body)[1]['message'], 'results_not_available')
