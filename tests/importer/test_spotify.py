"""No credentials or database needed: adversarial mocked provider responses."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec=importlib.util.spec_from_file_location('importer',Path(__file__).resolve().parents[2]/'scripts/spotify-import.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SOURCE='A'*22
ARTIST='B'*22
TRACK='C'*22


def item(**extra):
    return {'item':dict({'type':'track','id':TRACK,'name':'Original (Extended Mix)','artists':[{'id':ARTIST,'name':'Artist & Text'}],'album':{'name':'Album','release_date':'2026','release_date_precision':'year'},'is_playable':False},**extra)}


class SpotifyTests(unittest.TestCase):
    def test_validation_and_item_kinds(self):
        self.assertEqual(m.playlist_id('https://open.spotify.com/playlist/'+SOURCE+'?si=example'),SOURCE)
        for source in ('http://open.spotify.com/playlist/'+SOURCE,'https://evil.invalid/playlist/'+SOURCE,'https://open.spotify.com@evil.invalid/playlist/'+SOURCE,'spotify:playlist:'+SOURCE):
            with self.assertRaises(m.ImportFailure): m.playlist_id(source)
        self.assertEqual(m.normalize(item())['artists'][0]['name'],'Artist & Text')
        self.assertFalse(m.normalize(item())['available'])
        for entry,kind in (({'item':None},'removed'),(item(is_local=True),'skipped'),(item(type='episode'),'skipped'),(item(id=None),'invalid'),(item(artists=[]),'invalid')):
            self.assertEqual(m.normalize(entry)['kind'],kind)

    def test_pagination_snapshot_rescan_and_no_partial_plan(self):
        calls=[]; snapshots=iter(['one','two','three','three'])
        def fetch(url,**_):
            calls.append(url)
            if 'fields=' in url: return {'snapshot_id':next(snapshots)}
            if 'offset=1' in url: return {'offset':1,'total':2,'items':[item()], 'next':None}
            return {'offset':0,'total':2,'items':[item()], 'next':'https://api.spotify.com/v1/playlists/'+SOURCE+'/items?offset=1&market=IL'}
        adapter=m.Spotify('fixture',fetch)
        snapshot,rows=adapter.scan(SOURCE,'IL')
        self.assertEqual(snapshot,'three'); self.assertEqual(len(rows),2); self.assertEqual(adapter.pages,4)
        self.assertIn('market=IL',calls[1])
        with self.assertRaises(m.ImportFailure):
            m.Spotify('fixture',lambda *a,**k:{'snapshot_id':'x'} if 'fields=' in a[0] else {'offset':0,'total':2,'items':[item()],'next':None}).scan(SOURCE,'IL')

    def test_hostile_pagination_and_redirect(self):
        for next_url in ('https://evil.invalid/steal','https://api.spotify.com/v1/me','https://api.spotify.com@evil.invalid/v1/playlists/'+SOURCE+'/items'):
            def fetch(url,**_):
                if 'fields=' in url:return {'snapshot_id':'x'}
                return {'offset':0,'total':2,'items':[item()],'next':next_url}
            with self.assertRaises(m.ImportFailure):m.Spotify('secret',fetch).scan(SOURCE,'IL')
        with self.assertRaises(m.ImportFailure):m.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.invalid')

    def test_rate_limit_and_auth_do_not_loop_or_leak(self):
        delays=[]
        error=urllib.error.HTTPError('https://api.spotify.com',429,'private details',{'Retry-After':'2'},io.BytesIO(b'secret'))
        with patch.object(m.OPENER,'open',side_effect=[error,error]):
            with self.assertRaisesRegex(m.ImportFailure,'http_429'):m.request('https://api.spotify.com',retries=1,sleep=delays.append)
        self.assertEqual(delays,[2])
        error=urllib.error.HTTPError('url',403,'secret',{},io.BytesIO(b'secret'))
        with patch.object(m.OPENER,'open',side_effect=error) as call:
            with self.assertRaisesRegex(m.ImportFailure,'http_403'):m.request('https://api.spotify.com',sleep=delays.append)
            self.assertEqual(call.call_count,1)

    def test_protected_atomic_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'tokens.json'
            m.protected_write(path,{'access_token':'synthetic'})
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertEqual(m.protected_read(path)['access_token'],'synthetic')
            path.chmod(0o644)
            with self.assertRaises(m.ImportFailure):m.protected_read(path)

    def test_pkce_callback_state_scopes_and_token_exchange(self):
        from urllib.parse import parse_qs, urlsplit
        opened={}; exchanges=[]
        class Server:
            def __init__(self,address,handler):
                self.handler=handler
                self.address=address
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def handle_request(self):
                q=parse_qs(urlsplit(opened['url']).query)
                handler=self.handler.__new__(self.handler)
                handler.path='/callback?state='+q['state'][0]+'&code=synthetic-code'
                handler.send_response=lambda *_:None
                handler.end_headers=lambda:None
                handler.wfile=io.BytesIO()
                handler.do_GET()
        def exchange(url,**kwargs):
            exchanges.append((url,kwargs))
            return {'access_token':'synthetic','refresh_token':'synthetic-refresh','expires_in':3600}
        with tempfile.TemporaryDirectory() as directory, patch.object(m,'STATE',Path(directory)), patch.object(m.http.server,'HTTPServer',Server), patch.object(m.webbrowser,'open',side_effect=lambda url:opened.update(url=url)), patch.object(m,'request',side_effect=exchange), patch('builtins.print'):
            m.pkce_login('client')
            q=parse_qs(urlsplit(opened['url']).query)
            self.assertEqual(q['scope'],[m.SCOPES])
            self.assertEqual(q['code_challenge_method'],['S256'])
            body=exchanges[0][1]['body']
            self.assertEqual(body['code'],'synthetic-code')
            challenge=m.base64.urlsafe_b64encode(m.hashlib.sha256(body['code_verifier'].encode()).digest()).rstrip(b'=').decode()
            self.assertEqual(challenge,q['code_challenge'][0])
            self.assertNotIn('client_secret',body)
            self.assertEqual(m.protected_read(Path(directory)/'spotify.json')['client_id'],'client')

    def test_application_pkce_and_reject_remote_target(self):
        from urllib.parse import parse_qs, urlsplit
        opened={}; exchanges=[]
        class Server:
            def __init__(self,address,handler):self.handler=handler
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def handle_request(self):
                q=parse_qs(urlsplit(opened['url']).query)
                handler=self.handler.__new__(self.handler)
                handler.path=urlsplit(q['redirect_to'][0]).path+'?code=application-code'
                handler.send_response=lambda *_:None
                handler.end_headers=lambda:None
                handler.wfile=io.BytesIO()
                handler.do_GET()
        def exchange(url,**kwargs):
            exchanges.append((url,kwargs))
            return {'access_token':'user-jwt','refresh_token':'refresh','expires_in':3600}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'supabase.json'
            m.protected_write(path,{'url':'http://127.0.0.1:55321','anon_key':'public'})
            with patch.object(m.http.server,'HTTPServer',Server), patch.object(m.webbrowser,'open',side_effect=lambda url:opened.update(url=url)), patch.object(m,'request',side_effect=exchange), patch('builtins.print'):
                m.app_login(path)
            self.assertEqual(exchanges[0][1]['body']['auth_code'],'application-code')
            self.assertEqual(exchanges[0][0],'http://127.0.0.1:55321/auth/v1/token?grant_type=pkce')
            self.assertEqual(m.protected_read(path)['access_token'],'user-jwt')
            m.protected_write(path,{'url':'https://remote.supabase.co','anon_key':'public','access_token':'user'})
            with self.assertRaisesRegex(m.ImportFailure,'local_database_required'):m.Database(path)

    def test_malformed_optional_fields_remain_sanitized(self):
        for fields in ({'id':123},{'artists':[{'id':42,'name':'Artist'}]}):
            self.assertEqual(m.normalize(item(**fields))['kind'],'invalid')
        normalized=m.normalize(item(album={'release_date':'2026-99-01','release_date_precision':'day','images':[{'url':123}]},external_ids='malformed',linked_from='malformed'))
        self.assertIsNone(normalized['release_date'])
        self.assertIsNone(normalized['isrc'])
        self.assertIsNone(normalized['artwork'])

    def test_cli_apply_recovers_lost_acknowledgement_before_reporting_failure(self):
        import copy
        plan={'run':'synthetic-run','checksum':'checksum','status':'complete','items':[{'position':0,'candidate':{'kind':'track','id':TRACK},'evidence':{'reasons':[]},'decision':None,'receipt':None}]}
        committed=copy.deepcopy(plan)
        committed['items'][0]['receipt']={'outcome':'added','track_id':'canonical','new_track':True,'new_mapping':True,'new_artists':1}
        class Database:
            def rpc(self,name,**body):
                if name=='read_import_plan':return plan
                if name=='apply_import_item':raise m.ImportFailure('network_retry_exhausted')
                if name=='finish_import_run':return committed
                raise AssertionError(name)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'plan.json'; m.protected_write(path,plan)
            output=io.StringIO(); errors=io.StringIO()
            with patch.object(m,'Database',return_value=Database()), patch.object(m.sys,'argv',['spotify-import.py','apply','--plan',str(path)]), patch.object(m.sys,'stdout',output), patch.object(m.sys,'stderr',errors):
                self.assertEqual(m.main(),0)
            report=json.loads(output.getvalue())
            self.assertEqual(report['metrics']['failed'],0)
            self.assertEqual(report['metrics']['pending'],0)
            self.assertEqual(report['metrics']['applied'],1)
            self.assertEqual(errors.getvalue(),'')

    def test_review5_missing_null_malformed_and_unknown_types_require_review(self):
        missing=item(); del missing['item']['type']
        cases=[missing,item(type=None,is_local=True)]+[item(type=value) for value in (None,42,[],{},'', 'unknown-future-type')]
        for entry in cases:
            with self.subTest(entry=entry):
                self.assertEqual(m.normalize(entry)['kind'],'invalid')
        for entry in (item(type='episode'),item(type='track',is_local=True)):
            self.assertEqual(m.normalize(entry)['kind'],'skipped')
