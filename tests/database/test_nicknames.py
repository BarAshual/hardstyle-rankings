"""Database-enforced nickname uniqueness with transactional invitation acceptance."""
import concurrent.futures
import unittest
import psycopg
from test_foundation import ADMIN, MEMBER, SECOND, call, connect


class Nicknames(unittest.TestCase):
    def setUp(self):
        self.sid = call(ADMIN, 'create_season', 'Nickname tests', 2026, 1, 'Bar')
        self.inv = call(ADMIN, 'invite_member', self.sid, 'fixture2@example.invalid')

    def test_case_insensitive_same_season_conflict_rolls_back_acceptance(self):
        for nickname in ('Bar', 'bar', 'BAR', ' Bar '):
            with self.subTest(nickname=nickname), self.assertRaises(psycopg.errors.UniqueViolation) as ctx:
                call(MEMBER, 'accept_invitation', self.inv, nickname)
            self.assertEqual(ctx.exception.diag.message_primary, 'nickname_unavailable')
            self.assertIsNone(ctx.exception.diag.message_detail)
        with connect() as c:
            self.assertEqual(c.execute('select count(*) from public.season_members where season_id=%s and user_id=%s', (self.sid,MEMBER)).fetchone()[0],0)
            self.assertIsNone(c.execute('select accepted_by from public.season_invitations where id=%s',(self.inv,)).fetchone()[0])
        call(MEMBER, 'accept_invitation', self.inv, 'Duke')
        self.assertEqual(call(MEMBER,'inspect_invitation',self.inv)['nickname'], 'Duke')
        # Replay remains idempotent, without changing the saved nickname.
        self.assertEqual(call(MEMBER,'accept_invitation',self.inv,'BAR'),self.sid)
        self.assertEqual(call(MEMBER,'inspect_invitation',self.inv)['nickname'],'Duke')

    def test_display_casing_and_cross_season_reuse(self):
        other = call(ADMIN,'create_season','Other season',2027,1,'Other admin')
        invite = call(ADMIN,'invite_member',other,'fixture2@example.invalid')
        call(MEMBER,'accept_invitation',invite,'bAr')
        self.assertEqual(call(MEMBER,'inspect_invitation',invite)['nickname'],'bAr')

    def test_index_applies_to_owner_writes_and_concurrent_acceptance(self):
        with connect() as c:
            with self.assertRaises(psycopg.errors.UniqueViolation):
                c.execute("insert into public.season_members(season_id,user_id,nickname) values(%s,%s,'bar')",(self.sid,MEMBER))
        inv2 = call(ADMIN,'invite_member',self.sid,'fixture3@example.invalid')
        def accept(user,inv,nick):
            try:
                call(user,'accept_invitation',inv,nick)
                return 'accepted'
            except psycopg.errors.UniqueViolation as error:
                return error.diag.message_primary
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(accept,MEMBER,self.inv,'Raver')
            b=pool.submit(accept,SECOND,inv2,'RAVER')
            self.assertCountEqual([a.result(),b.result()],['accepted','nickname_unavailable'])
