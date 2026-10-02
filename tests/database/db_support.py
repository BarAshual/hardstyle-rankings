"""One local-project guard and one process-wide suite lock; no parallel test runs.

In-test concurrency still uses independent PostgreSQL connections. No credential
values are logged. Closing/killing the process releases the session advisory lock.
"""
import atexit
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo

ROOT = Path(__file__).resolve().parents[2]
CLI = os.environ.get('SUPABASE_CLI') or shutil.which('supabase') or str(ROOT / '.tools/supabase')
status = subprocess.run([CLI, 'status', '--output', 'json'], cwd=ROOT,
                        capture_output=True, text=True, check=True)
LOCAL = json.loads(status.stdout)
# Drop the captured output promptly: it includes local signing material.
del status
SUITE_LOCK = (18437, 20261001)


def validate_dsn(candidate, local):
    requested, expected = conninfo_to_dict(candidate), conninfo_to_dict(local)
    allowed = {'host', 'port', 'dbname', 'user', 'password'}
    if set(requested) - allowed or set(expected) - allowed:
        raise RuntimeError('Test DSN may not override routing, services, or connection options')
    for info in (requested, expected):
        if info.get('host') not in ('localhost', '127.0.0.1') or info.get('dbname') != 'postgres' or info.get('user') != 'postgres':
            raise RuntimeError('Tests require the disposable local Supabase postgres database')
    if requested.get('port') != expected.get('port'):
        raise RuntimeError('Test database must match this repository Supabase CLI status')
    # Pin the actual connection address: PGHOSTADDR or DNS cannot redirect it.
    return make_conninfo(**requested, hostaddr='127.0.0.1', connect_timeout='5')


if any(os.environ.get(k) for k in ('PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS')):
    raise RuntimeError('Unset libpq service/options overrides before running database tests')
DSN = validate_dsn(os.environ.get('TEST_DATABASE_URL', LOCAL['DB_URL']), LOCAL['DB_URL'])
_guard = psycopg.connect(DSN, autocommit=True, application_name='foundation-suite-guard')
try:
    # Read-only project/fixture fingerprint before any test can mutate the database.
    versions = {r[0] for r in _guard.execute('select version from supabase_migrations.schema_migrations')}
    expected_versions = {p.name.split('_')[0] for p in (ROOT / 'supabase/migrations').glob('*.sql')}
    users = _guard.execute('select id::text,email from auth.users order by id').fetchall()
    expected_users = [('00000000-0000-0000-0000-%012d' % n, 'fixture%d@example.invalid' % n) for n in range(1, 6)]
    if versions != expected_versions or users != expected_users:
        raise RuntimeError('Wrong project or non-synthetic Auth data: reset this disposable local project first')
    if not _guard.execute('select pg_try_advisory_lock(%s,%s)', SUITE_LOCK).fetchone()[0]:
        raise RuntimeError('Database suite is non-parallel: another run is already active')
except BaseException:
    _guard.close()
    raise
atexit.register(_guard.close)


@contextmanager
def rollback_connection():
    """Temporary DDL and Auth edits never commit, even after assertion failures."""
    c = psycopg.connect(DSN)
    try:
        c.execute("set local statement_timeout='10s'")
        c.execute("set local lock_timeout='5s'")
        yield c
    finally:
        try:
            c.rollback()
        finally:
            c.close()


def assume_user(c, user):
    c.execute('set local role authenticated')
    c.execute("select set_config('request.jwt.claims',%s,true)",
              (json.dumps({'sub': user, 'role': 'authenticated'}),))
