"""Exercise real PostgREST JWT/RLS/RPC boundaries using synthetic local JWTs.

This does not emulate the Google OAuth handshake. Local signing material is read
from Supabase status into memory and is never printed or written by this suite.
"""
import base64
import hashlib
import hmac
import json
import time
import unittest
import urllib.error
import urllib.request
import uuid

from test_foundation import ADMIN, MEMBER, OUTSIDER, call, connect
from db_support import LOCAL


class DataAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config=LOCAL
        cls.url=cls.config['API_URL']+'/rest/v1/'
        if not cls.url.startswith(('http://127.0.0.1:','http://localhost:')):
            raise RuntimeError('HTTP tests must use local Supabase')
        # Docker's clock can drift from the host after sleep. Sign fixture JWTs
        # on the local stack's clock without relaxing Data API assertions.
        with connect() as c:
            cls.server_epoch = float(c.execute('select extract(epoch from clock_timestamp())').fetchone()[0])
        cls.clock_start = time.monotonic()

    def token(self,user):
        def enc(v): return base64.urlsafe_b64encode(v).rstrip(b'=')
        now = int(self.server_epoch + time.monotonic() - self.clock_start)
        payload={'sub':user,'role':'authenticated','aud':'authenticated','exp':now+300,'iat':now,'app_metadata':{'provider':'google'}}
        message=enc(b'{"alg":"HS256","typ":"JWT"}')+b'.'+enc(json.dumps(payload).encode())
        signature=hmac.new(self.config['JWT_SECRET'].encode(),message,hashlib.sha256).digest()
        return (message+b'.'+enc(signature)).decode()

    def request(self,user,path,body=None,method=None):
        headers={'apikey':self.config['ANON_KEY'],'Content-Type':'application/json'}
        if user: headers['Authorization']='Bearer '+self.token(user)
        data=None if body is None else json.dumps(body,default=str).encode()
        request=urllib.request.Request(self.url+path,data=data,headers=headers,method=method)
        try:
            with urllib.request.urlopen(request,timeout=10) as response:
                raw=response.read()
                return response.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as response:
            return response.code,json.loads(response.read())

    def setUp(self):
        self.sid=call(ADMIN,'create_season','HTTP fixture',2026,1,'Admin')
        inv=call(ADMIN,'invite_member',self.sid,'fixture2@example.invalid')
        self.inv=inv
        call(MEMBER,'accept_invitation',inv,'Member')
        self.track=call(ADMIN,'add_track',self.sid,'HTTP track',['Synthetic'])
        call(ADMIN,'transition_season',self.sid,'VOTING')
        self.payload={'p_season':str(self.sid),'p_track':str(self.track),'p_choice':'SUPER_LIKE','p_expected_version':0,'p_action':str(uuid.uuid4())}

    def test_http_vote_retry_conflict_and_direct_write_denial(self):
        status,first=self.request(MEMBER,'rpc/cast_vote',self.payload)
        self.assertEqual(status,200,first)
        self.assertEqual(first['version'],1)
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',self.payload),(status,first))
        bad=dict(self.payload,p_choice='PASS')
        status,result=self.request(MEMBER,'rpc/cast_vote',bad)
        self.assertGreaterEqual(status,400)
        self.assertEqual(result['message'],'action_payload_conflict')
        for user in (MEMBER,ADMIN):
            for method,body in [('PATCH',{'choice':'PASS'}),('DELETE',None),('POST',{'season_id':str(self.sid),'user_id':MEMBER,'track_id':str(self.track),'choice':'LIKE','version':2,'updated_at':'2026-01-01T00:00:00Z'})]:
                path='votes' if method=='POST' else 'votes?season_id=eq.'+str(self.sid)
                status,result=self.request(user,path,body,method)
                self.assertEqual(status,403,result)
        # There is no user-id argument that can redirect a valid action to another member.
        status,result=self.request(MEMBER,'rpc/cast_vote',dict(self.payload,p_user_id=ADMIN))
        self.assertEqual(status,404,result)

    def test_http_secrecy_and_operational_progress(self):
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',self.payload)[0],200)
        for state in ('VOTING','LOCKED','REVEAL'):
            if state!='VOTING': call(ADMIN,'transition_season',self.sid,state)
            for user in (ADMIN,OUTSIDER):
                for table in ('votes','vote_events'):
                    self.assertEqual(self.request(user,table+'?season_id=eq.'+str(self.sid)),(200,[]))
            status,rows=self.request(ADMIN,'rpc/admin_progress',{'p_season':str(self.sid)})
            self.assertEqual(status,200,rows)
            self.assertEqual(set(rows[0]),{'user_id','nickname','role','active_tracks','rated','unrated','completion_percent'})
            status,rows=self.request(MEMBER,'votes?season_id=eq.'+str(self.sid))
            self.assertEqual(status,200)
            self.assertEqual(len(rows),1)
        status,result=self.request(OUTSIDER,'rpc/admin_progress',{'p_season':str(self.sid)})
        self.assertEqual(status,403,result)

    def test_http_admission_and_anon_denial(self):
        status,result=self.request(OUTSIDER,'rpc/accept_invitation',{'p_invitation':str(self.inv),'p_nickname':'Forwarded'})
        self.assertEqual(status,403,result)
        self.assertEqual(result['message'],'invitation_not_available')
        status,result=self.request(OUTSIDER,'rpc/cast_vote',self.payload)
        self.assertEqual(status,403,result)
        self.assertEqual(result['message'],'season_membership_required')
        status,result=self.request(None,'rpc/cast_vote',self.payload)
        self.assertIn(status,(401,403),result)
        status,result=self.request(None,'votes')
        self.assertIn(status,(401,403),result)

    def test_http_invitation_inspection_preserves_identity_boundary(self):
        status,result=self.request(MEMBER,'rpc/inspect_invitation',{'p_invitation':str(self.inv)})
        self.assertEqual(status,200,result)
        self.assertEqual(result['nickname'],'Member')
        self.assertEqual(set(result),{'season_id','season_name','year','nickname'})
        status,result=self.request(OUTSIDER,'rpc/inspect_invitation',{'p_invitation':str(self.inv)})
        self.assertEqual(status,403,result)
        self.assertEqual(result['message'],'invitation_not_available')
        status,result=self.request(None,'rpc/inspect_invitation',{'p_invitation':str(self.inv)})
        self.assertIn(status,(401,403),result)

    def test_http_rating_queue_persistence_growth_and_lock(self):
        body={'p_season':str(self.sid)}
        status,track=self.request(MEMBER,'rpc/next_unrated_track',body)
        self.assertEqual(status,200,track)
        self.assertEqual(track['id'],str(self.track))
        self.assertEqual(self.request(OUTSIDER,'rpc/next_unrated_track',body)[0],403)
        self.assertIn(self.request(None,'rpc/next_unrated_track',body)[0],(401,403))
        self.assertEqual(self.request(MEMBER,'rpc/next_unrated_track',dict(body,p_user_id=ADMIN))[0],404)
        for choice in ('PASS','LIKE','SUPER_LIKE'):
            status,track=self.request(MEMBER,'rpc/next_unrated_track',body)
            payload=dict(self.payload,p_track=track['id'],p_choice=choice,p_action=str(uuid.uuid4()))
            status,receipt=self.request(MEMBER,'rpc/cast_vote',payload)
            self.assertEqual(status,200,receipt)
            self.assertEqual(receipt['version'],1)
            self.assertEqual(self.request(MEMBER,'rpc/cast_vote',payload),(200,receipt))
            self.assertEqual(self.request(MEMBER,'rpc/next_unrated_track',body),(200,None))
            call(ADMIN,'add_track',self.sid,'Later release',['Fictional'])
        status,track=self.request(MEMBER,'rpc/next_unrated_track',body)
        self.assertEqual(status,200,track)
        payload=dict(self.payload,p_track=track['id'],p_action=str(uuid.uuid4()))
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',payload)[1]['message'],'super_like_limit')
        call(ADMIN,'transition_season',self.sid,'LOCKED')
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',dict(payload,p_choice='PASS'))[1]['message'],'voting_closed')
        self.assertEqual(self.request(MEMBER,'rpc/next_unrated_track',body)[1]['id'],track['id'])

    def test_http_my_picks_uses_own_rls_including_locked_and_reveal(self):
        from urllib.parse import urlencode
        columns='track_id,choice,version,catalog:season_tracks!inner(active,track:tracks!inner(id,title,artwork_url,spotify_url,apple_music_url,credits:track_artists(credit_order,artist:artists(name))))'
        def path(user):
            return 'votes?'+urlencode({'select':columns,'season_id':'eq.'+str(self.sid),'user_id':'eq.'+user,'order':'track_id.asc','limit':'500'})
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',self.payload)[0],200)
        for state in ('VOTING','LOCKED','REVEAL'):
            if state!='VOTING': call(ADMIN,'transition_season',self.sid,state)
            status,rows=self.request(MEMBER,path(MEMBER))
            self.assertEqual(status,200,rows)
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['choice'],'SUPER_LIKE')
            self.assertEqual(rows[0]['version'],1)
            self.assertEqual(rows[0]['catalog']['track']['credits'][0]['artist']['name'],'Synthetic')
            for other in (ADMIN,OUTSIDER):
                self.assertEqual(self.request(other,path(MEMBER)),(200,[]))
            self.assertIn(self.request(None,path(MEMBER))[0],(401,403))

    def test_http_edit_lifecycle_allowance_conflicts_and_recovery(self):
        first=dict(self.payload,p_choice='LIKE')
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',first)[1]['version'],1)
        extra=call(ADMIN,'add_track',self.sid,'Other track',['Other artist'])
        version=1
        for choice,available in [('PASS',1),('LIKE',1),('SUPER_LIKE',0),('LIKE',1)]:
            payload=dict(first,p_choice=choice,p_expected_version=version,p_action=str(uuid.uuid4()))
            status,receipt=self.request(MEMBER,'rpc/cast_vote',payload)
            self.assertEqual(status,200,receipt)
            self.assertEqual(receipt['version'],version+1)
            self.assertEqual(self.request(MEMBER,'rpc/cast_vote',payload),(200,receipt))
            progress=self.request(MEMBER,'rpc/my_progress',{'p_season':str(self.sid)})[1]
            self.assertEqual(progress['super_likes_available'],available)
            stale=dict(payload,p_action=str(uuid.uuid4()))
            self.assertEqual(self.request(MEMBER,'rpc/cast_vote',stale)[1]['message'],'vote_version_conflict')
            if choice=='SUPER_LIKE':
                second=dict(self.payload,p_track=str(extra),p_action=str(uuid.uuid4()))
                self.assertEqual(self.request(MEMBER,'rpc/cast_vote',second)[1]['message'],'super_like_limit')
            version+=1
        # The freed allowance can be consumed by another track.
        second=dict(self.payload,p_track=str(extra),p_action=str(uuid.uuid4()))
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',second)[0],200)
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',dict(payload,p_choice='PASS'))[1]['message'],'action_payload_conflict')
        call(ADMIN,'transition_season',self.sid,'LOCKED')
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',payload),(200,receipt))
        new_edit=dict(payload,p_expected_version=version,p_action=str(uuid.uuid4()))
        self.assertEqual(self.request(MEMBER,'rpc/cast_vote',new_edit)[1]['message'],'voting_closed')
        status,events=self.request(MEMBER,'vote_events?season_id=eq.'+str(self.sid))
        self.assertEqual(status,200,events)
        self.assertEqual(len(events),6) # first + four edits + second track, retries have no effect

    def test_http_nickname_conflict_is_friendly_and_atomic(self):
        inv=call(ADMIN,'invite_member',self.sid,'fixture4@example.invalid')
        status,result=self.request(OUTSIDER,'rpc/accept_invitation',{'p_invitation':str(inv),'p_nickname':'mEmBeR'})
        self.assertEqual(status,409,result)
        self.assertEqual(result['message'],'nickname_unavailable')
        self.assertIsNone(result['details'])
        self.assertEqual(self.request(OUTSIDER,'season_members?season_id=eq.'+str(self.sid)),(200,[]))
        self.assertIsNone(self.request(OUTSIDER,'rpc/inspect_invitation',{'p_invitation':str(inv)})[1]['nickname'])
