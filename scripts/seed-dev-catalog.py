#!/usr/bin/env python3
"""Explicit local-only synthetic catalog; no import, matching, or automatic seed."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo

ROOT = Path(__file__).resolve().parents[1]
TITLES = ["Neon Pressure", "Afterglow Protocol", "Concrete Sunrise", "Voltage Bloom",
          "Midnight Circuit", "Echoes of Tomorrow", "Static Horizon", "Bassline Atlas",
          "Final Frequency", "Chrome Hearts", "Northern Pulse", "Beyond the Kick"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--season', type=uuid.UUID, required=True)
    parser.add_argument('--admin-email', required=True)
    parser.add_argument('--open-voting', action='store_true', help='Advance SETUP to VOTING through the existing audited RPC')
    args = parser.parse_args()
    config = (ROOT / 'supabase/config.toml').read_text()
    if 'project_id = "hardstyle-rankings"' not in config:
        raise SystemExit('Refusing anything other than the existing local project')
    if any(os.environ.get(k) for k in ('PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGHOSTADDR')):
        raise SystemExit('Unset libpq routing/service overrides')
    env = dict(os.environ, SUPABASE_TELEMETRY_DISABLED='1')
    status = subprocess.run(['supabase', 'status', '--output', 'json'], cwd=ROOT,
                            env=env, capture_output=True, text=True, check=True)
    info = conninfo_to_dict(json.loads(status.stdout)['DB_URL'])
    if set(info) - {'host', 'port', 'dbname', 'user', 'password'} or info.get('host') not in ('127.0.0.1', 'localhost') or info.get('port') != '54322' or info.get('dbname') != 'postgres' or info.get('user') != 'postgres':
        raise SystemExit('Refusing non-local or unexpected database')
    with psycopg.connect(make_conninfo(**info, hostaddr='127.0.0.1', connect_timeout=5)) as c:
        c.execute("set local lock_timeout='5s'")
        c.execute("set local statement_timeout='15s'")
        actor = c.execute('select id from auth.users where private.normalize_email(email)=private.normalize_email(%s)', (args.admin_email,)).fetchone()
        if not actor:
            raise SystemExit('Admin must first sign in with Google')
        season = c.execute('select state from public.seasons where id=%s for update', (args.season,)).fetchone()
        if not season or season[0] not in ('SETUP', 'VOTING'):
            raise SystemExit('An existing SETUP or VOTING season is required')
        c.execute("select set_config('request.jwt.claims',%s,true)", (json.dumps({'sub': str(actor[0]), 'role': 'authenticated'}),))
        c.execute('set local role authenticated')
        # Check admin even when rerunning a fully populated fixture set.
        if not c.execute("select exists(select 1 from public.season_members where season_id=%s and user_id=auth.uid() and role='admin')", (args.season,)).fetchone()[0]:
            raise SystemExit('Season admin required')
        added = 0
        for i, title in enumerate(TITLES):
            title += ' [DEV]'
            if c.execute('select 1 from public.season_tracks st join public.tracks t on t.id=st.track_id where st.season_id=%s and t.title=%s', (args.season, title)).fetchone():
                continue
            artists = ['Phase Reactor [DEV]'] if i % 2 == 0 else ['Kick Observatory [DEV]', 'Night Array [DEV]']
            c.execute('select public.add_track(%s,%s,%s)', (args.season, title, artists))
            added += 1
        if args.open_voting and season[0] == 'SETUP':
            c.execute("select public.transition_season(%s,'VOTING')", (args.season,))
    print(f'Added {added} fictional development tracks. Existing votes and tracks preserved.')


if __name__ == '__main__':
    main()
