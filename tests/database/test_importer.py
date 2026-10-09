"""Importer contracts on real PostgreSQL and real local Data API, with synthetic data."""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import time
import unittest
import uuid

import psycopg
from psycopg.types.json import Jsonb
from test_foundation import ADMIN, MEMBER, OUTSIDER, UNVERIFIED, call, connect, rpc
import test_http as http_support
from db_support import assume_user, rollback_connection

spec = importlib.util.spec_from_file_location('spotify_import', Path(__file__).resolve().parents[2] / 'scripts/spotify-import.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def identifier(n):
    return '%022d' % n


def candidate(n, prefix, **extra):
    return dict({'kind':'track','id':identifier(n),'title':prefix+' track '+str(n),
                 'artists':[{'id':identifier(n+1000000),'name':prefix+' artist '+str(n)}],
                 'url':'https://open.spotify.com/track/'+identifier(n),'artwork':None,
                 'duration_ms':180000,'isrc':None,'release_date':'2026-01-01',
                 'release_precision':'day','available':True,'album':'Synthetic','original_id':None}, **extra)


class Importer(unittest.TestCase):
    def setUp(self):
        self.sid = call(ADMIN,'create_season','Importer '+str(uuid.uuid4()),2026,1,'Admin')
        self.prefix = str(uuid.uuid4())
        self.isrc = uuid.uuid4().hex[:12].upper()
        self.other_isrc = uuid.uuid4().hex[:12].upper()
        self.base = uuid.uuid4().int % 10**15
        self.source = identifier(self.base)
        self.cfg = call(ADMIN,'designate_import_source',self.sid,self.source,None,'Synthetic designation')

    def c(self, n=1, **extra):
        return candidate(self.base+n,self.prefix,**extra)

    def plan(self, candidates, market='IL', run=None):
        return call(ADMIN,'create_import_plan',self.sid,run or uuid.uuid4(),self.cfg['version'],self.source,market,'synthetic-snapshot',Jsonb(candidates))

    def apply(self, p, pos=0):
        return call(ADMIN,'apply_import_item',p['run'],p['checksum'],pos)

    def review(self, p, pos=0, **decision):
        call(ADMIN,'review_import_item',p['run'],p['checksum'],pos,Jsonb(dict({'action':'distinct','reason':'Synthetic evidence establishes a separate released recording'},**decision)))

    def error(self, message, f, *args):
        with self.assertRaises(psycopg.Error) as ctx:
            f(*args)
        self.assertEqual(ctx.exception.diag.message_primary,message)

    def scalar(self, query, params=()):
        with connect() as c:
            return c.execute(query,params).fetchone()[0]

    def test_850_repeat_875_votes_and_derived_growth(self):
        inv=call(ADMIN,'invite_member',self.sid,'fixture2@example.invalid')
        call(MEMBER,'accept_invitation',inv,'Member')
        call(ADMIN,'transition_season',self.sid,'VOTING')
        candidates=[self.c(n) for n in range(850)]
        first=self.plan(candidates)
        receipts=[self.apply(first,n) for n in range(850)]
        self.assertEqual(sum(r['outcome']=='added' for r in receipts),850)
        tid=receipts[0]['track_id']
        call(MEMBER,'cast_vote',self.sid,tid,'LIKE',0,uuid.uuid4())
        before_votes=self.scalar('select jsonb_agg(to_jsonb(v)) from public.votes v where season_id=%s',(self.sid,))
        before=self.scalar('select jsonb_agg(to_jsonb(v)) from public.vote_events v where season_id=%s',(self.sid,))
        for total, expected in ((850,0),(875,25)):
            p=self.plan([self.c(n) for n in range(total)])
            rows=[self.apply(p,n) for n in range(total)]
            self.assertEqual(sum(r['outcome']=='added' for r in rows),expected)
            self.assertEqual(sum(r['new_track'] for r in rows),expected)
            self.assertEqual(sum(r['new_artists'] for r in rows),expected)
        after=self.scalar('select jsonb_agg(to_jsonb(v)) from public.vote_events v where season_id=%s',(self.sid,))
        self.assertEqual(before,after)
        self.assertEqual(before_votes,self.scalar('select jsonb_agg(to_jsonb(v)) from public.votes v where season_id=%s',(self.sid,)))
        self.assertEqual(call(MEMBER,'my_progress',self.sid)['unrated'],874)
        self.assertEqual(self.scalar('select version from public.votes where season_id=%s and track_id=%s',(self.sid,tid)),1)

    def test_year_review_recovery_and_market_availability(self):
        c=self.c(release_date='2025',release_precision='year',available=False)
        p=self.plan([c],market='US')
        self.assertEqual(p['market'],'US')
        self.assertEqual(self.apply(p)['outcome'],'review-required')
        self.error('explicit_year_inclusion_required',self.review,p)
        self.review(p,include_year=True)
        first=self.apply(p)
        self.assertEqual(first['outcome'],'added')
        self.assertEqual(self.apply(p),first)
        repeat=self.plan([c])
        self.assertIsNotNone(repeat['items'][0]['decision'])
        self.assertEqual(self.apply(repeat)['outcome'],'already-present')
        clean=self.plan([self.c(2,available=False)])
        self.assertEqual(self.apply(clean)['outcome'],'added')
        changed=self.plan([dict(c,release_date='2024')])
        self.assertIsNone(changed['items'][0]['decision'])
        self.assertEqual(self.cfg['market'],'IL')

    def test_duplicate_occurrences_and_artist_identity_order(self):
        a,b=self.c(),self.c(2)
        b['artists']=[a['artists'][0],b['artists'][0],a['artists'][0]]
        p=self.plan([a,a,b])
        first=self.apply(p)
        self.assertEqual(self.apply(p,1)['outcome'],'skipped')
        second=self.apply(p,2)
        self.assertEqual(second['new_artists'],1)
        with connect() as c:
            rows=c.execute('select a.name from public.track_artists ta join public.artists a on a.id=ta.artist_id where track_id=%s order by credit_order',(second['track_id'],)).fetchall()
        self.assertEqual([r[0] for r in rows],[a['artists'][0]['name'],b['artists'][1]['name']])
        collision=self.c(3,artists=[dict(a['artists'][0],id=identifier(self.base+9999999))])
        p=self.plan([collision])
        self.assertIn('artist_name_collision',p['items'][0]['evidence']['reasons'])
        self.assertEqual(self.apply(p)['outcome'],'review-required')
        self.review(p)
        self.assertEqual(self.apply(p)['new_artists'],1)
        self.assertTrue(first['new_track'])

    def test_versions_shared_isrc_hold_and_explicit_distinct(self):
        original=self.c(isrc=self.isrc)
        p=self.plan([original]); tid=self.apply(p)['track_id']
        for n,label in enumerate(('Remix','Edit','Extended','Radio','VIP','Live','Acoustic','Rework'),2):
            new=self.c(n,title=original['title']+' ('+label+')',isrc=original['isrc'])
            p=self.plan([new])
            self.assertEqual(self.apply(p)['outcome'],'review-required')
            self.review(p)
            self.assertNotEqual(self.apply(p)['track_id'],tid)
        ambiguous=self.c(20,title=original['title'],isrc=original['isrc'])
        p=self.plan([ambiguous]); self.assertEqual(self.apply(p)['outcome'],'review-required')
        self.review(p,action='attach',target=tid,same_version=True)
        self.assertEqual(self.apply(p)['track_id'],tid)

    def test_safe_refresh_curated_artwork_and_material_conflict(self):
        c=self.c(artwork='https://i.scdn.co/image/AAA')
        p=self.plan([c]); tid=self.apply(p)['track_id']
        refreshed=dict(c,artwork='https://i.scdn.co/image/BBB',album='New album',available=False)
        self.assertEqual(self.apply(self.plan([refreshed]))['outcome'],'already-present')
        self.assertEqual(self.scalar('select artwork_url from public.tracks where id=%s',(tid,)),refreshed['artwork'])
        with connect() as conn:
            conn.execute("update public.tracks set artwork_url='https://curated.invalid/art',artwork_curated=true where id=%s",(tid,))
        self.apply(self.plan([dict(refreshed,artwork=None)]))
        self.assertEqual(self.scalar('select artwork_url from public.tracks where id=%s',(tid,)),'https://curated.invalid/art')
        with connect() as conn:
            conn.execute('update public.tracks set artwork_url=%s,artwork_curated=true where id=%s',(refreshed['artwork'],tid))
        self.apply(self.plan([dict(refreshed,artwork='https://i.scdn.co/image/CCC')]))
        self.assertEqual(self.scalar('select artwork_url from public.tracks where id=%s',(tid,)),refreshed['artwork'])
        bad=self.plan([dict(c,title=c['title']+' Remix')])
        self.assertIn('material_identity_conflict',bad['items'][0]['evidence']['reasons'])
        self.assertEqual(self.apply(bad)['outcome'],'review-required')
        self.error('mapping_reassignment_forbidden',self.review,bad)
        self.review(bad,action='keep')
        self.assertEqual(self.apply(bad)['track_id'],tid)
        self.assertEqual(self.scalar('select title from public.tracks where id=%s',(tid,)),c['title'])

    def test_known_provider_isrc_contradiction_requires_review(self):
        c=self.c(isrc=self.isrc)
        self.apply(self.plan([c]))
        p=self.plan([dict(c,isrc=self.other_isrc)])
        self.assertIn('material_identity_conflict',p['items'][0]['evidence']['reasons'])
        self.assertEqual(self.apply(p)['outcome'],'review-required')

    def test_source_replacement_stale_plan_and_inactive_preservation(self):
        p=self.plan([self.c(),self.c(2)])
        first=self.apply(p)
        with connect() as conn:
            conn.execute('update public.season_tracks set active=false where season_id=%s and track_id=%s',(self.sid,first['track_id']))
        repeat=self.plan([self.c()])
        self.assertEqual(self.apply(repeat)['outcome'],'already-withdrawn')
        call(ADMIN,'designate_import_source',self.sid,identifier(self.base+10),'US','Explicit replacement')
        self.error('stale_source',self.apply,p,1)
        self.assertEqual(self.apply(p),first)
        self.assertEqual(self.scalar('select count(*) from public.season_tracks where season_id=%s',(self.sid,)),1)
        self.assertEqual(self.scalar('select count(*) from private.source_events where season_id=%s',(self.sid,)),2)

    def test_same_scan_shared_isrc_holds_both_and_recovers_distinct_reviews(self):
        p=self.plan([self.c(isrc=self.isrc),self.c(2,isrc=self.isrc)])
        for n in (0,1):
            self.assertIn('suspected_match',p['items'][n]['evidence']['reasons'])
            self.assertEqual(self.apply(p,n)['outcome'],'review-required')
            self.review(p,n)
        first=self.apply(p,0)
        second=self.apply(p,1)
        self.assertEqual(first['outcome'],'added')
        self.assertEqual(second['outcome'],'added')
        self.assertNotEqual(first['track_id'],second['track_id'])

    def test_review1_missing_isrc_refresh_retains_match_signal(self):
        original=self.c(isrc=self.isrc)
        tid=self.apply(self.plan([original]))['track_id']
        self.apply(self.plan([dict(original,isrc=None)]))
        p=self.plan([self.c(2,isrc=self.isrc)])
        self.assertIn('suspected_match',p['items'][0]['evidence']['reasons'])
        self.assertIn(tid,p['items'][0]['evidence']['matches'])
        self.assertEqual(self.apply(p)['outcome'],'review-required')

    def test_review2_late_optional_baselines_survive_missing_observations(self):
        initial=self.c(isrc=None,duration_ms=None)
        self.apply(self.plan([initial]))
        supplied=dict(initial,isrc=self.isrc,duration_ms=180000)
        self.assertEqual(self.apply(self.plan([supplied]))['outcome'],'already-present')
        self.apply(self.plan([initial]))
        baseline=self.scalar("select identity from private.track_providers where provider='spotify' and provider_id=%s",(initial['id'],))
        self.assertEqual(baseline['isrc'],self.isrc)
        self.assertEqual(baseline['duration_ms'],180000)
        for contradiction in (dict(supplied,isrc=self.other_isrc),dict(supplied,duration_ms=190000)):
            p=self.plan([contradiction])
            self.assertIn('material_identity_conflict',p['items'][0]['evidence']['reasons'])
            self.assertEqual(self.apply(p)['outcome'],'review-required')

    def test_review3_distinct_does_not_cover_new_external_match(self):
        seed=self.c(isrc=self.isrc)
        self.apply(self.plan([seed]))
        stale=self.plan([self.c(2,isrc=self.isrc)])
        self.review(stale)
        external=self.plan([self.c(3,isrc=self.isrc)])
        self.review(external)
        self.assertEqual(self.apply(external)['outcome'],'added')
        result=self.apply(stale)
        self.assertEqual(result,{'outcome':'review-required','reason':'evidence_changed'})
        self.assertIsNone(self.scalar("select receipt from private.import_items where run_id=%s and position=0",(stale['run'],)))
        fresh=self.plan([self.c(2,isrc=self.isrc)])
        self.assertIsNone(fresh['items'][0]['decision'])
        self.review(fresh)
        self.assertEqual(self.apply(fresh)['outcome'],'added')

    def test_review3_unreviewed_same_run_peer_is_not_an_external_match_exemption(self):
        left,right=self.c(isrc=self.isrc),self.c(2,isrc=self.isrc)
        p=self.plan([left,right]); self.review(p,0)
        external=self.plan([right])
        self.assertEqual(self.apply(external)['outcome'],'added')
        self.assertEqual(self.apply(p,0),{'outcome':'review-required','reason':'evidence_changed'})

    def test_review4_whitespace_equivalent_same_run_distinct_admission(self):
        left=self.c(title=self.prefix+' Song  Name')
        right=self.c(2,title=self.prefix+' Song\tName')
        p=self.plan([left,right])
        for n in (0,1):
            self.assertIn('suspected_match',p['items'][n]['evidence']['reasons'])
            self.review(p,n)
        a,b=self.apply(p,0),self.apply(p,1)
        self.assertEqual(a['outcome'],'added')
        self.assertEqual(b['outcome'],'added')
        self.assertNotEqual(a['track_id'],b['track_id'])

    def artist_pair(self, **right_fields):
        left=self.c(isrc=self.isrc)
        right=self.c(2,isrc=self.isrc,artists=[{'id':identifier(self.base+2000000),'name':left['artists'][0]['name']}])
        right.update(right_fields)
        return left,right

    def test_same_plan_artist_distinct(self):
        for collision in ('isrc','title','artist_only'):
            with self.subTest(collision=collision):
                left,right=self.artist_pair()
                if collision=='title':
                    left['isrc']=right['isrc']=None
                    right['title']=left['title'].replace(' track ','\ttrack  ')
                elif collision=='artist_only':
                    left['isrc']=right['isrc']=None
                p=self.plan([left,right])
                for n in (0,1):
                    self.assertIn('artist_name_collision',p['items'][n]['evidence']['reasons'])
                    self.assertEqual(len(p['items'][n]['evidence']['same_run_artist_peers']),1)
                    self.review(p,n)
                a,b=self.apply(p,0),self.apply(p,1)
                self.assertEqual(a['outcome'],'added')
                self.assertEqual(b['outcome'],'added',b)
                self.assertNotEqual(a['track_id'],b['track_id'])
                self.assertEqual(self.scalar('select count(distinct artist_id) from public.track_artists where track_id in (%s,%s)',(a['track_id'],b['track_id'])),2)
                self.assertEqual(self.apply(p,1),b)
                # Use fresh synthetic identities for the next collision variant.
                self.setUp()

    def test_same_plan_artist_external_collision_requires_fresh_review(self):
        left,right=self.artist_pair()
        p=self.plan([left,right]); self.review(p,0); self.review(p,1); self.apply(p,0)
        external=self.c(3,artists=[{'id':identifier(self.base+3000000),'name':left['artists'][0]['name']}])
        q=self.plan([external]); self.review(q); self.assertEqual(self.apply(q)['outcome'],'added')
        self.assertEqual(self.apply(p,1),{'outcome':'review-required','reason':'evidence_changed'})
        fresh=self.plan([right]); self.assertIsNone(fresh['items'][0]['decision'])
        self.assertEqual(len(fresh['items'][0]['evidence']['artist_matches']),2)
        self.review(fresh); self.assertEqual(self.apply(fresh)['outcome'],'added')

    def test_same_plan_artist_unapproved_peer_cannot_accommodate(self):
        left,right=self.artist_pair()
        p=self.plan([left,right]); self.review(p,1)
        self.assertEqual(self.apply(p,0)['outcome'],'review-required')
        # Import the unapproved peer in a separate clean plan; its original
        # same-plan item has neither an explicit approval nor an apply receipt.
        self.assertEqual(self.apply(self.plan([left]))['outcome'],'added')
        self.assertEqual(self.apply(p,1),{'outcome':'review-required','reason':'evidence_changed'})

    def test_same_plan_artist_changed_peer_cannot_accommodate(self):
        for change in ('canonical_name','candidate_name','extra_mapping'):
            with self.subTest(change=change):
                left,right=self.artist_pair()
                p=self.plan([left,right]); self.review(p,0); self.review(p,1)
                a=self.apply(p,0)
                with connect() as c:
                    aid=c.execute('select artist_id from public.track_artists where track_id=%s',(a['track_id'],)).fetchone()[0]
                    if change=='canonical_name':
                        c.execute('update public.artists set name=upper(name) where id=%s',(aid,))
                    elif change=='candidate_name':
                        altered=dict(left,artists=[dict(left['artists'][0],name=left['artists'][0]['name'].upper())])
                        c.execute('update private.import_items set candidate=%s where run_id=%s and position=0',(Jsonb(altered),p['run']))
                    else:
                        c.execute("insert into private.artist_providers(provider,provider_id,artist_id,observed_name) values('spotify',%s,%s,%s)",(identifier(self.base+4000000),aid,left['artists'][0]['name']))
                self.assertEqual(self.apply(p,1),{'outcome':'review-required','reason':'evidence_changed'})
                self.setUp()

    def test_same_plan_artist_exact_provider_reuses_mapping(self):
        left=self.c()
        first=self.apply(self.plan([left]))
        right=self.c(2,artists=left['artists'])
        p=self.plan([right]); self.assertEqual(p['items'][0]['evidence']['reasons'],[])
        second=self.apply(p)
        self.assertEqual(second['outcome'],'added'); self.assertEqual(second['new_artists'],0)
        self.assertNotEqual(first['track_id'],second['track_id'])
        self.assertEqual(self.scalar('select count(distinct artist_id) from public.track_artists where track_id in (%s,%s)',(first['track_id'],second['track_id'])),1)

    def test_artist_collision_existing_reason_binds_new_external_artist(self):
        left,right=self.artist_pair()
        self.apply(self.plan([left]))
        p=self.plan([right]); self.review(p)
        external=self.c(3,artists=[{'id':identifier(self.base+3000000),'name':left['artists'][0]['name']}])
        q=self.plan([external]); self.review(q); self.apply(q)
        self.assertEqual(self.apply(p),{'outcome':'review-required','reason':'evidence_changed'})

    def test_artist_staging_index_handles_nonrecordings(self):
        for artists in (None,{},42):
            self.assertEqual(self.scalar('select private.import_artist_names(%s)',(Jsonb({'kind':'invalid','artists':artists}),)),[])
        p=self.plan([{'kind':'invalid'},{'kind':'skipped'},{'kind':'removed'}])
        self.assertEqual([self.apply(p,n)['outcome'] for n in range(3)],['review-required','skipped','review-required'])

    def test_review5_malformed_types_are_review_required_in_database(self):
        candidates=[]
        for value in (None,42,[],{},''):
            c=self.c()
            raw={'item':{'type':value,'id':c['id'],'name':c['title'],'artists':c['artists']}}
            candidates.append(importer.normalize(raw))
        p=self.plan(candidates)
        for n in range(len(candidates)):
            self.assertEqual(self.apply(p,n)['outcome'],'review-required')
        self.assertEqual(self.scalar('select count(*) from public.season_tracks where season_id=%s',(self.sid,)),0)

    def test_review1_reviewed_alternate_isrc_is_retained_after_missing_refresh(self):
        original=self.c(isrc=self.isrc)
        tid=self.apply(self.plan([original]))['track_id']
        changed=dict(original,isrc=self.other_isrc)
        p=self.plan([changed]); self.review(p,action='keep'); self.apply(p)
        self.apply(self.plan([dict(original,isrc=None)]))
        for code in (self.isrc,self.other_isrc):
            p=self.plan([self.c(2,isrc=code)])
            self.assertIn(tid,p['items'][0]['evidence']['matches'])
            self.assertEqual(self.apply(p)['outcome'],'review-required')

    def test_review2_baseline_inputs_are_validated_without_mutation(self):
        initial=self.c(isrc=None,duration_ms=None)
        self.apply(self.plan([initial]))
        for fields in ({'isrc':'invalid'},{'isrc':42},{'duration_ms':0},{'duration_ms':-1},{'duration_ms':86400000},{'duration_ms':'180000'}):
            self.error('invalid_candidate',self.plan,[dict(initial,**fields)])
        baseline=self.scalar("select identity from private.track_providers where provider='spotify' and provider_id=%s",(initial['id'],))
        self.assertIsNone(baseline['isrc']); self.assertIsNone(baseline['duration_ms'])

    def test_review3_peer_receipt_cannot_mask_changed_material_metadata(self):
        left,right=self.c(isrc=self.isrc),self.c(2,isrc=self.isrc)
        p=self.plan([left,right]); self.review(p,0); self.review(p,1)
        admitted=self.apply(p,0)
        with connect() as c:
            c.execute('update public.tracks set title=title || %s where id=%s',(' (changed)',admitted['track_id']))
        self.assertEqual(self.apply(p,1),{'outcome':'review-required','reason':'evidence_changed'})

    def test_review3_reviewed_peers_do_not_mask_an_unrelated_new_match(self):
        p=self.plan([self.c(isrc=self.isrc),self.c(2,isrc=self.isrc)])
        self.review(p,0); self.review(p,1); self.apply(p,0)
        external=self.plan([self.c(3,isrc=self.isrc)]); self.review(external); self.apply(external)
        self.assertEqual(self.apply(p,1),{'outcome':'review-required','reason':'evidence_changed'})

    def test_review3_safe_peer_refresh_preserves_valid_same_run_review(self):
        left,right=self.c(isrc=self.isrc),self.c(2,isrc=self.isrc)
        p=self.plan([left,right]); self.review(p,0); self.review(p,1)
        first=self.apply(p,0)
        self.apply(self.plan([dict(left,isrc=None,artwork='https://i.scdn.co/image/SAFE')]))
        second=self.apply(p,1)
        self.assertEqual(second['outcome'],'added')
        self.assertNotEqual(first['track_id'],second['track_id'])

    def test_review_upgrade_backfills_accepted_receipts_without_rewriting_history(self):
        root=Path(__file__).resolve().parents[2]
        legacy=(root/'supabase/migrations/20261007000100_catalog_import.sql').read_text()
        correction=(root/'supabase/migrations/20261008000100_import_evidence.sql').read_text()
        with rollback_connection() as c:
            for name in ('private.import_candidate','private.import_evidence','public.create_import_plan','public.apply_import_item'):
                start=legacy.index('create function '+name+'(')
                end=legacy.index('end $$;',start)+len('end $$;')
                c.execute(legacy[start:end].replace('create function','create or replace function',1))
            assume_user(c,ADMIN)
            original=self.c(40,isrc=None,duration_ms=None)
            def legacy_apply(candidate):
                p=rpc(c,'create_import_plan',self.sid,uuid.uuid4(),self.cfg['version'],self.source,'IL','legacy',Jsonb([candidate]))
                return rpc(c,'apply_import_item',p['run'],p['checksum'],0)
            first=legacy_apply(original)
            legacy_apply(dict(original,isrc=self.isrc,duration_ms=180000))
            legacy_apply(original)
            c.execute('reset role')
            before=c.execute("select candidate,evidence,decision,receipt from private.import_items where receipt->>'track_id'=%s order by run_id,position",(first['track_id'],)).fetchall()
            row=c.execute("select identity,observation,accepted_isrcs from private.track_providers where provider_id=%s",(original['id'],)).fetchone()
            self.assertIsNone(row[0]['isrc']); self.assertIsNone(row[1]['isrc']); self.assertEqual(row[2],[])
            start=correction.index('update private.track_providers p set accepted_isrcs=')
            end=correction.index('-- Catalog-only material evidence',start)
            c.execute(correction[start:end])
            row=c.execute("select identity,accepted_isrcs,track_id from private.track_providers where provider_id=%s",(original['id'],)).fetchone()
            self.assertEqual(row[0]['isrc'],self.isrc); self.assertEqual(row[0]['duration_ms'],180000)
            self.assertEqual(row[1],[self.isrc]); self.assertEqual(str(row[2]),first['track_id'])
            after=c.execute("select candidate,evidence,decision,receipt from private.import_items where receipt->>'track_id'=%s order by run_id,position",(first['track_id'],)).fetchall()
            self.assertEqual(before,after)
            # Definitions, rows, and all temporary history are restored by rollback.

    def test_review_upgrade_preserves_unchanged_year_decision_on_fresh_plan(self):
        root=Path(__file__).resolve().parents[2]
        legacy=(root/'supabase/migrations/20261007000100_catalog_import.sql').read_text()
        correction=(root/'supabase/migrations/20261008000100_import_evidence.sql').read_text()
        with rollback_connection() as c:
            for name in ('private.import_candidate','private.import_evidence','public.create_import_plan','public.apply_import_item'):
                start=legacy.index('create function '+name+'('); end=legacy.index('end $$;',start)+len('end $$;')
                c.execute(legacy[start:end].replace('create function','create or replace function',1))
            assume_user(c,ADMIN)
            candidate=self.c(50,release_date='2025')
            old=rpc(c,'create_import_plan',self.sid,uuid.uuid4(),self.cfg['version'],self.source,'IL','legacy',Jsonb([candidate]))
            decision={'action':'distinct','reason':'Previously reviewed unchanged date evidence','include_year':True}
            rpc(c,'review_import_item',old['run'],old['checksum'],0,Jsonb(decision))
            c.execute('reset role')
            start=correction.index('create function private.import_catalog_evidence')
            c.execute(correction[start:].replace('create function','create or replace function'))
            artist_correction=(root/'supabase/migrations/20261008000200_import_artist_evidence.sql').read_text()
            c.execute(artist_correction[artist_correction.index('create or replace function private.import_evidence'):])
            assume_user(c,ADMIN)
            self.assertEqual(rpc(c,'apply_import_item',old['run'],old['checksum'],0)['outcome'],'review-required')
            fresh=rpc(c,'create_import_plan',self.sid,uuid.uuid4(),self.cfg['version'],self.source,'IL','new',Jsonb([candidate]))
            self.assertEqual(fresh['items'][0]['decision'],decision)
            self.assertEqual(rpc(c,'apply_import_item',fresh['run'],fresh['checksum'],0)['outcome'],'added')

    def test_plan_binding_authority_privacy_and_direct_writes(self):
        p=self.plan([self.c()])
        for user in (MEMBER,OUTSIDER,UNVERIFIED):
            with self.assertRaises(psycopg.Error):
                call(user,'apply_import_item',p['run'],p['checksum'],0)
        self.error('stale_plan',call,ADMIN,'apply_import_item',p['run'],'tampered',0)
        self.error('plan_payload_conflict',self.plan,[self.c(2)],'IL',p['run'])
        with connect(ADMIN) as c:
            with self.assertRaises(psycopg.Error):
                c.execute('select * from private.import_items')
        with connect(ADMIN) as c:
            with self.assertRaises(psycopg.Error):
                c.execute('insert into private.artist_providers values (\'spotify\',\'fake\',%s,\'fake\')',(uuid.uuid4(),))
        self.assertNotIn('votes',json.dumps(p))
        self.error('invalid_candidate',self.plan,[dict(self.c(),authorization='secret')])

    def test_concurrent_import_and_lost_acknowledgement(self):
        a=self.plan([self.c()]); b=self.plan([self.c()])
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            rows=list(pool.map(self.apply,[a,b]))
        self.assertEqual(sum(r['outcome']=='added' for r in rows),1)
        self.assertEqual(rows[0]['track_id'],rows[1]['track_id'])
        self.assertEqual(self.apply(a),rows[0])
        p=self.plan([self.c(2),self.c(3)])
        receipt=self.apply(p)
        call(ADMIN,'finish_import_run',p['run'],p['checksum'],True)
        self.assertEqual(call(ADMIN,'read_import_plan',p['run'])['status'],'interrupted')
        self.assertEqual(self.apply(p),receipt)
        self.apply(p,1)
        self.assertEqual(call(ADMIN,'finish_import_run',p['run'],p['checksum'],False)['status'],'complete')

    def test_transition_wins_lock_race(self):
        call(ADMIN,'transition_season',self.sid,'VOTING')
        p=self.plan([self.c()])
        with connect(ADMIN) as c:
            rpc(c,'transition_season',self.sid,'LOCKED')
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                future=pool.submit(self.apply,p)
                time.sleep(.1)
                self.assertFalse(future.done())
                c.commit()
                self.error('catalog_closed',future.result)
        self.assertEqual(self.scalar('select count(*) from public.season_tracks where season_id=%s',(self.sid,)),0)

    def test_import_wins_lock_race_receipt_after_closure(self):
        call(ADMIN,'transition_season',self.sid,'VOTING')
        p=self.plan([self.c(),self.c(2)])
        with connect(ADMIN) as c:
            receipt=rpc(c,'apply_import_item',p['run'],p['checksum'],0)
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                future=pool.submit(call,ADMIN,'transition_season',self.sid,'LOCKED')
                time.sleep(.1); self.assertFalse(future.done()); c.commit(); future.result()
        self.assertEqual(self.apply(p),receipt)
        self.error('catalog_closed',self.apply,p,1)


class ImportHTTP(unittest.TestCase):
    setUpClass = classmethod(http_support.DataAPI.setUpClass.__func__)
    setUp = http_support.DataAPI.setUp
    token = http_support.DataAPI.token
    request = http_support.DataAPI.request
    # Inherit fixture JWT mechanics without rerunning its full tests here.
    def test_import_data_api_boundary(self):
        prefix=str(uuid.uuid4()); source=identifier(uuid.uuid4().int%10**15)
        status,cfg=self.request(ADMIN,'rpc/designate_import_source',{'p_season':str(self.sid),'p_source':source,'p_market':None,'p_reason':'Synthetic'})
        self.assertEqual(status,200,cfg)
        body={'p_season':str(self.sid),'p_run':str(uuid.uuid4()),'p_source_version':cfg['version'],'p_source':source,'p_market':'IL','p_snapshot':'fixture','p_candidates':[candidate(int(source)+1,prefix)]}
        status,plan=self.request(ADMIN,'rpc/create_import_plan',body)
        self.assertEqual(status,200,plan)
        payload={'p_run':plan['run'],'p_checksum':plan['checksum'],'p_position':0}
        self.assertEqual(self.request(MEMBER,'rpc/apply_import_item',payload)[0],403)
        status,receipt=self.request(ADMIN,'rpc/apply_import_item',payload)
        self.assertEqual(status,200,receipt); self.assertEqual(receipt['outcome'],'added')
        self.assertEqual(self.request(ADMIN,'rpc/apply_import_item',payload),(200,receipt))
        self.assertEqual(self.request(ADMIN,'rpc/apply_import_item',dict(payload,p_actor=ADMIN))[0],404)
        for table in ('import_runs','import_items','import_reviews','track_providers'):
            self.assertEqual(self.request(ADMIN,table)[0],404)

    def test_same_plan_artist_distinct_data_api(self):
        sid=call(ADMIN,'create_season','HTTP artist '+str(uuid.uuid4()),2026,1,'Admin')
        base=uuid.uuid4().int%10**15; source=identifier(base)
        cfg=call(ADMIN,'designate_import_source',sid,source,None,'Synthetic HTTP artist source')
        prefix=str(uuid.uuid4()); left=candidate(base+1,prefix,isrc=uuid.uuid4().hex[:12].upper())
        right=candidate(base+2,prefix,isrc=left['isrc'],artists=[{'id':identifier(base+2000000),'name':left['artists'][0]['name']}])
        body={'p_season':sid,'p_run':str(uuid.uuid4()),'p_source_version':cfg['version'],'p_source':source,'p_market':'IL','p_snapshot':'synthetic','p_candidates':[left,right]}
        status,plan=self.request(ADMIN,'rpc/create_import_plan',body); self.assertEqual(status,200,plan)
        receipts=[]
        for pos in (0,1):
            payload={'p_run':plan['run'],'p_checksum':plan['checksum'],'p_position':pos}
            decision={'action':'distinct','reason':'Explicit synthetic same-plan artist review'}
            self.assertEqual(self.request(ADMIN,'rpc/review_import_item',dict(payload,p_decision=decision))[0],204)
        for pos in (0,1):
            payload={'p_run':plan['run'],'p_checksum':plan['checksum'],'p_position':pos}
            self.assertEqual(self.request(MEMBER,'rpc/apply_import_item',payload)[0],403)
            status,receipt=self.request(ADMIN,'rpc/apply_import_item',payload)
            self.assertEqual(status,200,receipt); self.assertEqual(receipt['outcome'],'added',receipt)
            receipts.append(receipt)
        self.assertNotEqual(receipts[0]['track_id'],receipts[1]['track_id'])
        self.assertNotEqual(receipts[0]['catalog_evidence']['artists'][0]['id'],receipts[1]['catalog_evidence']['artists'][0]['id'])
