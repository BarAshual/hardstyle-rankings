"""Personal queue behavior using real committed votes and fresh SQL sessions."""
import hashlib
import unittest
import uuid
import psycopg
from test_foundation import ADMIN, MEMBER, OUTSIDER, call, connect


class RatingQueue(unittest.TestCase):
    def setUp(self):
        self.sid = call(ADMIN, 'create_season', 'Rating fixtures', 2026, 1, 'Admin')
        inv = call(ADMIN, 'invite_member', self.sid, 'fixture2@example.invalid')
        call(MEMBER, 'accept_invitation', inv, 'Member')
        self.tracks = [call(ADMIN, 'add_track', self.sid, f'Queue {i}', ['First', 'Second']) for i in range(12)]
        call(ADMIN, 'transition_season', self.sid, 'VOTING')

    def test_queue_is_stable_personal_active_and_metadata_only(self):
        def expected(user):
            return str(min(self.tracks, key=lambda t: (hashlib.md5(f'{user}:{self.sid}:{t}'.encode()).hexdigest(), str(t))))
        for user in (ADMIN, MEMBER):
            first = call(user, 'next_unrated_track', self.sid)
            self.assertEqual(first, call(user, 'next_unrated_track', self.sid))
            self.assertEqual(first['id'], expected(user))
            self.assertEqual(first['artists'], ['First', 'Second'])
            self.assertEqual(set(first), {'id', 'title', 'artists', 'artwork_url', 'spotify_url', 'apple_music_url'})
        first = call(MEMBER, 'next_unrated_track', self.sid)
        with connect() as c:
            c.execute('update public.season_tracks set active=false where season_id=%s and track_id=%s', (self.sid, first['id']))
        self.assertNotEqual(call(MEMBER, 'next_unrated_track', self.sid)['id'], first['id'])
        # Other members' votes never change this user's queue.
        before = call(MEMBER, 'next_unrated_track', self.sid)
        call(ADMIN, 'cast_vote', self.sid, before['id'], 'LIKE', 0, uuid.uuid4())
        self.assertEqual(call(MEMBER, 'next_unrated_track', self.sid), before)

    def test_persisted_choices_completion_and_catalog_growth(self):
        seen = set()
        for index in range(12):
            track = call(MEMBER, 'next_unrated_track', self.sid)
            self.assertNotIn(track['id'], seen)
            seen.add(track['id'])
            choice = ['SUPER_LIKE', 'PASS', 'LIKE'][min(index, 2)]
            result = call(MEMBER, 'cast_vote', self.sid, track['id'], choice, 0, uuid.uuid4())
            self.assertEqual(result['version'], 1)
        self.assertIsNone(call(MEMBER, 'next_unrated_track', self.sid))
        self.assertEqual(call(MEMBER, 'my_progress', self.sid)['rated'], 12)
        extra = call(ADMIN, 'add_track', self.sid, 'New release', [])
        self.assertEqual(call(MEMBER, 'next_unrated_track', self.sid)['id'], str(extra))
        self.assertEqual(call(MEMBER, 'my_progress', self.sid)['unrated'], 1)

    def test_queue_requires_membership_and_no_user_override(self):
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            call(OUTSIDER, 'next_unrated_track', self.sid)
        with connect(role='anon') as c:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                c.execute('select public.next_unrated_track(%s)', (self.sid,))
