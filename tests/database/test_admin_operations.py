"""Synthetic SQL/Data API regressions for the admin closeout repairs."""
import unittest
import uuid

import psycopg

from test_foundation import ADMIN, MEMBER, SECOND, OUTSIDER, call, connect
from test_results import ResultsFixture
import test_http as http


class AdminOperations(ResultsFixture, unittest.TestCase):
    setUpClass = classmethod(http.DataAPI.setUpClass.__func__)
    token = http.DataAPI.token
    request = http.DataAPI.request

    def test_members_projection_authorization_counts_and_season_isolation(self):
        other = self.season('Other admin metadata', admin=OUTSIDER, members=())
        track = call(ADMIN, 'add_track', self.sid, 'Synthetic operational track', ['Synthetic'])
        call(ADMIN, 'transition_season', self.sid, 'VOTING')
        call(MEMBER, 'cast_vote', self.sid, track, 'SUPER_LIKE', 0, uuid.uuid4())
        keys = {'user_id', 'email', 'nickname', 'role', 'active_tracks', 'rated',
                'unrated', 'completion_percent', 'super_likes_used', 'super_likes_available'}
        for state in ('VOTING', 'LOCKED', 'REVEAL'):
            if state != 'VOTING':
                call(ADMIN, 'transition_season', self.sid, state)
            status, rows = self.request(ADMIN, 'rpc/admin_members', {'p_season': str(self.sid)})
            self.assertEqual(status, 200, rows)
            self.assertEqual({r['user_id'] for r in rows}, {ADMIN, MEMBER, SECOND})
            for row in rows:
                self.assertEqual(set(row), keys)
                self.assertEqual(row['active_tracks'], 1)
                self.assertEqual(row['rated'], int(row['user_id'] == MEMBER))
                self.assertEqual(row['super_likes_available'], 9 if row['user_id'] == MEMBER else 10)
            for user in (MEMBER, OUTSIDER, None):
                self.assertIn(self.request(user, 'rpc/admin_members', {'p_season': str(self.sid)})[0], (401, 403))
            self.assertEqual(self.request(ADMIN, 'rpc/admin_members', {'p_season': str(other)})[0], 403)
        with connect(ADMIN) as c:
            self.assertEqual(c.execute('select count(*) from public.votes where season_id=%s', (self.sid,)).fetchone()[0], 0)

    def test_role_changes_keep_last_admin_and_append_only_actual_changes(self):
        self.error('last_admin_required', call, ADMIN, 'set_member_role', self.sid, ADMIN, 'member')
        for role in (None, 'owner', ''):
            self.error('invalid_member_role_payload', call, ADMIN, 'set_member_role', self.sid, MEMBER, role)
        self.error('season_admin_required', call, MEMBER, 'set_member_role', self.sid, MEMBER, 'admin')
        self.error('season_admin_required', call, OUTSIDER, 'set_member_role', self.sid, MEMBER, 'admin')
        self.error('season_membership_required', call, ADMIN, 'set_member_role', self.sid, OUTSIDER, 'admin')
        other = self.season('Independent roles')
        payload = {'p_season': str(self.sid), 'p_user': MEMBER, 'p_role': 'admin'}
        status, result = self.request(ADMIN, 'rpc/set_member_role', payload)
        self.assertEqual(status, 200, result)
        self.assertTrue(result['changed'])
        self.assertFalse(self.request(ADMIN, 'rpc/set_member_role', payload)[1]['changed'])
        self.assertTrue(call(MEMBER, 'set_member_role', self.sid, ADMIN, 'member')['changed'])
        self.error('last_admin_required', call, MEMBER, 'set_member_role', self.sid, MEMBER, 'member')
        self.error('season_admin_required', call, ADMIN, 'set_member_role', self.sid, ADMIN, 'admin')
        with connect() as c:
            history = c.execute('select old_role,new_role from private.season_membership_events where season_id=%s order by changed_at', (self.sid,)).fetchall()
            self.assertEqual(history, [('member', 'admin'), ('admin', 'member')])
            self.assertEqual(c.execute('select role from public.season_members where season_id=%s and user_id=%s', (other, ADMIN)).fetchone()[0], 'admin')
        for query in ('update private.season_membership_events set new_role=old_role',
                      'delete from private.season_membership_events',
                      'truncate private.season_membership_events'):
            with self.assertRaisesRegex(psycopg.Error, 'immutable_event'):
                with connect() as c:
                    c.execute(query)

    def test_concurrent_demotions_leave_one_admin(self):
        call(ADMIN, 'set_member_role', self.sid, MEMBER, 'admin')
        answers = self.concurrent([
            lambda: call(ADMIN, 'set_member_role', self.sid, ADMIN, 'member'),
            lambda: call(MEMBER, 'set_member_role', self.sid, MEMBER, 'member'),
        ])
        self.assertEqual(sorted(answer[0] for answer in answers), ['error', 'ok'])
        self.assertIn(('error', 'last_admin_required'), answers)
        self.assertEqual(self.owner_scalar("select count(*) from public.season_members where season_id=%s and role='admin'", (self.sid,)), 1)
