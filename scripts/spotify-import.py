#!/usr/bin/env python3
"""Bounded local operator importer. Standard library only; no browser/admin secrets."""
import argparse
import base64
import datetime
import hashlib
import http.server
import http.client
import json
import os
from pathlib import Path
import random
import re
import secrets
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

STATE = Path(__file__).resolve().parents[1] / '.importer'
ID = re.compile(r'^[A-Za-z0-9]{22}$')
SCOPES = 'playlist-read-private playlist-read-collaborative'


class ImportFailure(Exception):
    """Only fixed, sanitized identifiers reach stderr."""


def playlist_id(value):
    if ID.fullmatch(value):
        return value
    u = urllib.parse.urlsplit(value)
    m = re.fullmatch(r'/playlist/([A-Za-z0-9]{22})/?', u.path)
    if u.scheme != 'https' or u.netloc != 'open.spotify.com' or not m or u.fragment:
        raise ImportFailure('invalid_playlist')
    return m[1]


def protected_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ImportFailure('unprotected_state_file')
        with os.fdopen(fd, 'r') as f:
            fd = None
            return json.load(f)
    finally:
        if fd is not None:
            os.close(fd)


def protected_write(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.is_symlink() or path.parent.stat().st_mode & 0o077:
        raise ImportFailure('unprotected_state_directory')
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ImportFailure('unexpected_redirect')


OPENER = urllib.request.build_opener(NoRedirect)


def request(url, headers=None, body=None, form=False, retries=4, sleep=time.sleep, on_retry=None):
    data = None if body is None else (urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode())
    headers = dict(headers or {})
    if body is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
    for attempt in range(retries + 1):
        try:
            with OPENER.open(urllib.request.Request(url, data=data, headers=headers), timeout=20) as response:
                raw = response.read(8_000_001)
                if len(raw) > 8_000_000:
                    raise ImportFailure('response_too_large')
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            code = e.code
            delay = e.headers.get('Retry-After', '1')
            # Deliberately discard response bodies, which may contain private data.
            e.close()
            if code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise ImportFailure('http_' + str(code)) from None
            if code == 429:
                try:
                    wait = max(0, float(delay))
                except ValueError:
                    raise ImportFailure('invalid_retry_after') from None
                if wait > 60:
                    raise ImportFailure('rate_limit_resume_later')
            else:
                wait = 2 ** attempt + random.random()
            if on_retry:
                on_retry(code)
            sleep(wait)
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
            if attempt == retries:
                raise ImportFailure('network_retry_exhausted') from None
            if on_retry:
                on_retry(0)
            sleep(2 ** attempt + random.random())
    raise ImportFailure('retry_exhausted')


def pkce_login(client, port=8888):
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state = secrets.token_urlsafe(32)
    redirect = f'http://127.0.0.1:{port}/callback'
    result = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path != '/callback' or q.get('state') != [state]:
                self.send_error(400)
                return
            result['code'] = q.get('code', [None])[0]
            result['received'] = True
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'Authorization received. Return to the terminal.')

    with http.server.HTTPServer(('127.0.0.1', port), Callback) as server:
        server.timeout = 1
        query = urllib.parse.urlencode({'client_id': client, 'response_type': 'code', 'redirect_uri': redirect,
                                      'scope': SCOPES, 'state': state, 'code_challenge_method': 'S256', 'code_challenge': challenge})
        url = 'https://accounts.spotify.com/authorize?' + query
        print('Open Spotify authorization:', url)
        webbrowser.open(url)
        deadline = time.monotonic() + 180
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if not result.get('code'):
        raise ImportFailure('spotify_authorization_incomplete')
    token = request('https://accounts.spotify.com/api/token', body={'grant_type': 'authorization_code',
                    'client_id': client, 'code': result['code'], 'redirect_uri': redirect, 'code_verifier': verifier}, form=True, retries=0)
    token['client_id'] = client
    token['expires_at'] = time.time() + token['expires_in']
    protected_write(STATE / 'spotify.json', token)


def spotify_token():
    token = protected_read(STATE / 'spotify.json')
    if token['expires_at'] <= time.time() + 60:
        fresh = request('https://accounts.spotify.com/api/token', body={'grant_type': 'refresh_token',
                        'client_id': token['client_id'], 'refresh_token': token['refresh_token']}, form=True)
        token.update(fresh)
        token['expires_at'] = time.time() + fresh['expires_in']
        protected_write(STATE / 'spotify.json', token)
    return token['access_token']


def normalize(entry):
    if not isinstance(entry, dict):
        return {'kind': 'invalid'}
    t = entry.get('item', entry.get('track'))
    if t is None:
        return {'kind': 'removed'}
    if not isinstance(t, dict):
        return {'kind': 'invalid'}
    if t.get('type') == 'episode':
        return {'kind': 'skipped'}
    if t.get('type') != 'track':
        return {'kind': 'invalid'}
    if entry.get('is_local') is True or t.get('is_local') is True:
        return {'kind': 'skipped'}
    title = t.get('name')
    artists = t.get('artists')
    if not isinstance(t.get('id'), str) or not ID.fullmatch(t['id']) or not isinstance(title, str) or not title.strip() or len(title)>500 or not isinstance(artists, list) or not 1 <= len(artists) <= 30:
        return {'kind': 'invalid'}
    credits = []
    for a in artists:
        if not isinstance(a, dict) or not isinstance(a.get('id'), str) or not ID.fullmatch(a['id']) or not isinstance(a.get('name'), str) or not a['name'].strip() or len(a['name'])>300:
            return {'kind': 'invalid'}
        credits.append({'id': a['id'], 'name': a['name'].strip()})
    album = t.get('album') if isinstance(t.get('album'), dict) else {}
    date = album.get('release_date')
    precision = album.get('release_date_precision')
    if not isinstance(date, str) or not re.fullmatch(r'\d{4}(-\d{2}){0,2}', date):
        date = precision = None
    if date is not None:
        try:
            expected_length = {'year': 4, 'month': 7, 'day': 10}[precision]
            if len(date) != expected_length:
                raise ValueError()
            datetime.date.fromisoformat(date + ('-01-01' if precision == 'year' else '-01' if precision == 'month' else ''))
        except (ValueError, KeyError, TypeError):
            date = precision = None
    images = album.get('images') if isinstance(album.get('images'), list) else []
    artwork = next((i.get('url') for i in images if isinstance(i, dict) and isinstance(i.get('url'), str) and re.fullmatch(r'https://i\.scdn\.co/image/[A-Za-z0-9]+', i['url'])), None)
    duration = t.get('duration_ms')
    duration = duration if isinstance(duration, int) and not isinstance(duration, bool) and 0 < duration < 86400000 else None
    external_ids = t.get('external_ids') if isinstance(t.get('external_ids'), dict) else {}
    isrc = external_ids.get('isrc')
    isrc = isrc if isinstance(isrc, str) and re.fullmatch(r'[A-Za-z0-9]{12}', isrc) else None
    linked = t.get('linked_from') if isinstance(t.get('linked_from'), dict) else {}
    original = linked.get('id')
    original = original if isinstance(original, str) and ID.fullmatch(original) else None
    return {'kind': 'track', 'id': t['id'], 'title': title.strip(), 'artists': credits,
            'duration_ms': duration, 'isrc': isrc, 'release_date': date, 'release_precision': precision,
            'album': album.get('name') if isinstance(album.get('name'), str) else None, 'artwork': artwork,
            'url': 'https://open.spotify.com/track/' + t['id'], 'available': t.get('is_playable') if isinstance(t.get('is_playable'), bool) else None, 'original_id': original}


class Spotify:
    def __init__(self, token, fetch=request):
        self.token, self.fetch = token, fetch
        self.pages = self.observed = self.rate_limit_retries = self.transient_retries = 0

    def retry(self, code):
        if code == 429:
            self.rate_limit_retries += 1
        else:
            self.transient_retries += 1

    def get(self, url):
        if not isinstance(url, str):
            raise ImportFailure('invalid_provider_url')
        u = urllib.parse.urlsplit(url)
        if u.scheme != 'https' or u.netloc != 'api.spotify.com' or not u.path.startswith('/v1/playlists/') or u.fragment:
            raise ImportFailure('invalid_provider_url')
        result = self.fetch(url, headers={'Authorization': 'Bearer ' + self.token}, on_retry=self.retry)
        if not isinstance(result, dict):
            raise ImportFailure('invalid_provider_response')
        return result

    def scan(self, source, market):
        base = 'https://api.spotify.com/v1/playlists/' + playlist_id(source)
        for _ in range(3):
            before = self.get(base + '?fields=snapshot_id')
            snapshot = before.get('snapshot_id')
            if not isinstance(snapshot, str) or not snapshot:
                raise ImportFailure('missing_snapshot')
            candidates, visited = [], set()
            url = base + '/items?' + urllib.parse.urlencode({'limit': 50, 'market': market, 'additional_types': 'track,episode'})
            total = None
            while url:
                if url in visited or len(visited) >= 100:
                    raise ImportFailure('pagination_limit')
                u = urllib.parse.urlsplit(url)
                if u.path != urllib.parse.urlsplit(base).path + '/items':
                    raise ImportFailure('invalid_pagination')
                visited.add(url)
                page = self.get(url)
                if not isinstance(page.get('items'), list) or page.get('offset') != len(candidates) or not isinstance(page.get('total'), int):
                    raise ImportFailure('incomplete_playlist_access')
                if total is None:
                    total = page['total']
                if total != page['total'] or total > 5000:
                    raise ImportFailure('playlist_changed_or_too_large')
                candidates.extend(normalize(x) for x in page['items'])
                self.pages += 1
                self.observed += len(page['items'])
                url = page.get('next')
                if url is not None and not isinstance(url, str):
                    raise ImportFailure('invalid_pagination')
            after = self.get(base + '?fields=snapshot_id')
            if after.get('snapshot_id') == snapshot and len(candidates) == total:
                return snapshot, candidates
        raise ImportFailure('playlist_changed_during_scan')


def local_url(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'http' or u.hostname != '127.0.0.1' or not u.port or u.username or u.password or u.path or u.query or u.fragment:
        raise ImportFailure('local_database_required')
    return url


def app_login(path, port=8889):
    config = protected_read(path)
    base = local_url(config['url'].rstrip('/'))
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    nonce = secrets.token_urlsafe(32)
    callback_path = '/callback/' + nonce
    redirect = f'http://127.0.0.1:{port}' + callback_path
    result = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path != callback_path:
                self.send_error(400)
                return
            result['code'] = q.get('code', [None])[0]
            result['received'] = True
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'Application authorization received. Return to the terminal.')

    with http.server.HTTPServer(('127.0.0.1', port), Callback) as server:
        server.timeout = 1
        url = base + '/auth/v1/authorize?' + urllib.parse.urlencode({'provider': 'google', 'redirect_to': redirect,
                                                                  'code_challenge': challenge, 'code_challenge_method': 's256'})
        print('Open application Google authorization:', url)
        webbrowser.open(url)
        deadline = time.monotonic() + 180
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if not result.get('code'):
        raise ImportFailure('application_authorization_incomplete')
    tokens = request(base + '/auth/v1/token?grant_type=pkce', headers={'apikey': config['anon_key']},
                     body={'auth_code': result['code'], 'code_verifier': verifier}, retries=0)
    tokens.setdefault('expires_at', time.time() + tokens['expires_in'])
    config.update({k: tokens[k] for k in ('access_token', 'refresh_token', 'expires_at')})
    protected_write(path, config)


class Database:
    def __init__(self, path, fetch=request):
        config = protected_read(path)
        self.url = config['url'].rstrip('/')
        local_url(self.url)
        if config.get('expires_at', float('inf')) <= time.time() + 60:
            fresh = fetch(self.url + '/auth/v1/token?grant_type=refresh_token', headers={'apikey': config['anon_key']},
                          body={'refresh_token': config['refresh_token']}, retries=0)
            fresh.setdefault('expires_at', time.time() + fresh['expires_in'])
            config.update({k: fresh[k] for k in ('access_token', 'refresh_token', 'expires_at')})
            protected_write(path, config)
        self.headers = {'apikey': config['anon_key'], 'Authorization': 'Bearer ' + config['access_token']}
        self.fetch = fetch

    def rpc(self, name, **body):
        return self.fetch(self.url + '/rest/v1/rpc/' + name, headers=self.headers, body=body)


def summary(plan):
    counts = {}
    new_tracks = new_artists = added = 0
    metrics = {'unique_provider_ids': 0, 'duplicate_occurrences': 0, 'known_provider_ids': 0, 'unavailable': 0, 'release_year_warnings': 0, 'accepted_exceptions': 0, 'new_mappings': 0, 'eligible_to_apply': 0, 'applied': 0, 'pending': 0}
    seen = set()
    tracks = set()
    for item in plan['items']:
        receipt = item['receipt'] or {}
        outcome = receipt.get('outcome') or ('auto-admissible' if not item['evidence']['reasons'] else 'review-required')
        candidate = item['candidate']
        reasons = item['evidence']['reasons']
        decision = item['decision'] or {}
        if not receipt and decision.get('action') in ('defer', 'decline'):
            outcome = decision['action']
        if candidate.get('kind') == 'skipped' or 'duplicate_occurrence' in reasons:
            outcome = receipt.get('outcome', 'skipped')
        identity = candidate.get('id')
        if candidate.get('kind') == 'track' and identity not in seen:
            metrics['unique_provider_ids'] += 1
            seen.add(identity)
            metrics['known_provider_ids'] += int(bool(item['evidence'].get('known_track')))
            metrics['unavailable'] += int(candidate.get('available') is False)
            metrics['release_year_warnings'] += int('release_year' in reasons)
            metrics['accepted_exceptions'] += int(bool(reasons) and decision.get('action') in ('distinct', 'attach', 'keep'))
            eligible = not reasons or decision.get('action') in ('distinct', 'attach', 'keep')
            metrics['eligible_to_apply'] += int(eligible)
            metrics['applied'] += int(eligible and bool(receipt))
            metrics['pending'] += int(eligible and not receipt)
        metrics['duplicate_occurrences'] += int('duplicate_occurrence' in reasons)
        metrics['new_mappings'] += int(receipt.get('new_mapping', False))
        if receipt.get('track_id'):
            tracks.add(receipt['track_id'])
        counts[outcome] = counts.get(outcome, 0) + 1
        new_tracks += int(receipt.get('new_track', False))
        new_artists += receipt.get('new_artists', 0)
        added += int(outcome == 'added')
    return {'run': plan['run'], 'status': plan['status'], 'occurrences': len(plan['items']), 'outcomes': counts,
            'new_tracks': new_tracks, 'new_artists': new_artists, 'added_memberships': added, 'distinct_resolved_tracks': len(tracks), 'metrics': metrics}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', type=Path, default=STATE / 'supabase.json')
    sub = parser.add_subparsers(dest='command', required=True)
    app = sub.add_parser('app-login')
    app.add_argument('--port', type=int, default=8889)
    login = sub.add_parser('spotify-login')
    login.add_argument('--client-id', required=True)
    login.add_argument('--port', type=int, default=8888)
    designate = sub.add_parser('designate')
    designate.add_argument('--season', required=True)
    designate.add_argument('--playlist', required=True)
    designate.add_argument('--market', default='IL')
    designate.add_argument('--reason', required=True)
    dry = sub.add_parser('dry-run')
    dry.add_argument('--season', required=True)
    dry.add_argument('--playlist', required=True)
    dry.add_argument('--market')
    dry.add_argument('--output', type=Path, required=True)
    dry.add_argument('--run', default=str(uuid.uuid4()))
    for command in ('apply', 'review', 'status'):
        p = sub.add_parser(command)
        p.add_argument('--plan', type=Path, required=True)
        if command == 'review':
            p.add_argument('--decisions', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'app-login':
        app_login(args.session, args.port)
        return
    if args.command == 'spotify-login':
        pkce_login(args.client_id, args.port)
        return
    db = Database(args.session)
    if args.command == 'designate':
        result = db.rpc('designate_import_source', p_season=args.season, p_source=playlist_id(args.playlist), p_market=args.market, p_reason=args.reason)
        print(json.dumps(result))
        return
    if args.command == 'dry-run':
        context = db.rpc('import_context', p_season=args.season)
        source = playlist_id(args.playlist)
        if source != context['source_id']:
            raise ImportFailure('explicit_designation_required')
        market = args.market or context['market']
        if not re.fullmatch('[A-Z]{2}', market):
            raise ImportFailure('invalid_market')
        adapter = Spotify(spotify_token())
        try:
            snapshot, candidates = adapter.scan(source, market)
        except BaseException:
            print(json.dumps({'status': 'interrupted' if sys.exc_info()[0] == KeyboardInterrupt else 'failed', 'pages_observed': adapter.pages, 'occurrences_observed': adapter.observed, 'rate_limit_retries': adapter.rate_limit_retries, 'transient_retries': adapter.transient_retries}), file=sys.stderr)
            raise
        protected_write(args.output, {'run': args.run, 'checksum': None, 'status': 'interrupted'})
        plan = db.rpc('create_import_plan', p_season=args.season, p_run=args.run, p_source_version=context['version'], p_source=source, p_market=market, p_snapshot=snapshot, p_candidates=candidates)
        plan['scan'] = {'pages': adapter.pages, 'rate_limit_retries': adapter.rate_limit_retries, 'transient_retries': adapter.transient_retries}
        protected_write(args.output, plan)
    else:
        local = protected_read(args.plan)
        plan = db.rpc('read_import_plan', p_run=local['run'])
        if local.get('checksum') is not None and local['checksum'] != plan['checksum']:
            raise ImportFailure('stale_plan')
        common = {'p_run': plan['run'], 'p_checksum': plan['checksum']}
        if args.command == 'review':
            decisions = protected_read(args.decisions)
            if decisions['checksum'] != plan['checksum']:
                raise ImportFailure('stale_decisions')
            for item in decisions['items']:
                db.rpc('review_import_item', **common, p_position=item['position'], p_decision=item['decision'])
            plan = db.rpc('read_import_plan', p_run=plan['run'])
        elif args.command == 'apply':
            failed = []
            try:
                for item in plan['items']:
                    try:
                        db.rpc('apply_import_item', **common, p_position=item['position'])
                    except ImportFailure as error:
                        failed.append({'position': item['position'], 'error': str(error)})
                        if str(error) in ('http_401', 'http_403'):
                            break
                plan = db.rpc('finish_import_run', **common)
            except KeyboardInterrupt:
                db.rpc('finish_import_run', **common, p_interrupted=True)
                raise
            recovered = {item['position'] for item in plan['items'] if item['receipt'] is not None}
            failed = [error for error in failed if error['position'] not in recovered]
            if failed:
                print(json.dumps({'item_errors': failed}), file=sys.stderr)
        protected_write(args.plan, plan)
    report = summary(plan)
    report['scan'] = plan.get('scan', {})
    report['metrics']['failed'] = 0
    if args.command == 'apply':
        eligible_positions = {item['position'] for item in plan['items'] if not item['evidence']['reasons'] or (item['decision'] or {}).get('action') in ('distinct', 'attach', 'keep')}
        failure_count = sum(error['position'] in eligible_positions for error in failed)
        report['metrics']['failed'] = failure_count
        report['metrics']['pending'] -= failure_count
    print(json.dumps(report))
    if args.command == 'apply' and plan['status'] != 'complete':
        return 2
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('interrupted: resume with the same plan', file=sys.stderr)
        sys.exit(130)
    except (ImportFailure, OSError, ValueError, KeyError, TypeError):
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, ImportFailure) else 'invalid_configuration_or_response', file=sys.stderr)
        sys.exit(1)
