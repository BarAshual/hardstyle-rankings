"""Reviewed listening links preserve canonical identity, votes and audit secrecy."""
import json
import unittest
import uuid
import psycopg
from psycopg.types.json import Jsonb
from test_foundation import ADMIN, MEMBER, OUTSIDER, call, connect
from test_importer import candidate, identifier


class AppleLinks(unittest.TestCase):
    def setUp(self):
        self.sid = call(ADMIN, 'create_season', 'Apple link '+str(uuid.uuid4()), 2026, 50, 'Admin')
        self.n = uuid.uuid4().int % 10**15
        cfg = call(ADMIN, 'designate_import_source', self.sid, identifier(self.n), 'IL', 'Synthetic source')
        p = call(ADMIN, 'create_import_plan', self.sid, uuid.uuid4(), cfg['version'], identifier(self.n), 'IL', 'test', Jsonb([candidate(self.n, str(uuid.uuid4()))]))
        self.tid = call(ADMIN, 'apply_import_item', p['run'], p['checksum'], 0)['track_id']
        self.url = 'https://music.apple.com/il/song/synthetic/1234567890'

    def link(self, user=ADMIN, expected=None, url=None):
        return call(user, 'set_reviewed_apple_link', self.sid, self.tid, expected, url or self.url, 'Reviewed recording and version')

    def error(self, expected, fn):
        with self.assertRaises(psycopg.Error) as e:
            fn()
        self.assertEqual(e.exception.diag.message_primary, expected)

    def test_authorization_url_and_membership(self):
        self.error('season_admin_required', lambda: self.link(OUTSIDER))
        self.error('invalid_apple_link', lambda: self.link(url='https://music.apple.com.evil.test/il/song/x/123'))
        self.error('invalid_apple_link', lambda: self.link(url=self.url+'?token=secret'))
        self.error('track_not_available', lambda: call(ADMIN,'set_reviewed_apple_link',self.sid,uuid.uuid4(),None,self.url,'Review'))
        with connect() as c:
            self.assertFalse(c.execute("select has_function_privilege('anon','public.set_reviewed_apple_link(uuid,uuid,text,text,text)','EXECUTE')").fetchone()[0])
            self.assertFalse(c.execute("select has_table_privilege('authenticated','private.track_link_events','SELECT')").fetchone()[0])

    def test_retry_conflict_and_immutable_event(self):
        self.assertEqual(self.link()['status'], 'updated')
        self.assertEqual(self.link()['status'], 'already_present')
        with connect() as c:
            self.assertEqual(c.execute('select count(*) from private.track_link_events where track_id=%s',(self.tid,)).fetchone()[0],1)
        self.error('link_changed', lambda: self.link(url='https://music.apple.com/il/song/other/1234567891'))
        self.assertEqual(self.link(expected=self.url,url='https://music.apple.com/il/album/synthetic/111?i=222')['status'],'updated')
        with self.assertRaises(psycopg.Error):
            with connect() as c:
                c.execute('delete from private.track_link_events where track_id=%s',(self.tid,))

    def test_voting_history_and_closed_season(self):
        invite=call(ADMIN,'invite_member',self.sid,'fixture2@example.invalid')
        call(MEMBER,'accept_invitation',invite,'Member')
        call(ADMIN,'transition_season',self.sid,'VOTING')
        action=uuid.uuid4()
        receipt=call(MEMBER,'cast_vote',self.sid,self.tid,'LIKE',0,action)
        with connect() as c:
            before=c.execute('select to_jsonb(v) from public.votes v where season_id=%s',(self.sid,)).fetchall()
            events=c.execute('select to_jsonb(v) from public.vote_events v where season_id=%s',(self.sid,)).fetchall()
        self.link()
        self.assertEqual(call(MEMBER,'cast_vote',self.sid,self.tid,'LIKE',0,action),receipt)
        with connect() as c:
            self.assertEqual(c.execute('select to_jsonb(v) from public.votes v where season_id=%s',(self.sid,)).fetchall(),before)
            self.assertEqual(c.execute('select to_jsonb(v) from public.vote_events v where season_id=%s',(self.sid,)).fetchall(),events)
        call(ADMIN,'transition_season',self.sid,'LOCKED')
        self.error('catalog_closed',lambda:self.link())
