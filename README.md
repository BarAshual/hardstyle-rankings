# Hardstyle Rankings

Private annual ranking for a small group of friends. The database foundation uses Supabase Auth and PostgreSQL; no frontend or result calculation is implemented.

Start with [Database foundation](docs/database-foundation.md) for local setup, migration/API contracts, security, tests, and remaining deployment prerequisites.

- [Product specification](docs/product-spec.md)
- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Decision record](docs/decisions.md)

Local quick start (Docker, Supabase CLI, Python 3.9+):

```sh
supabase start
supabase db reset --local
python3 -m venv .venv
mkdir -p .tools/tmp
TMPDIR="$PWD/.tools/tmp" .venv/bin/python -m pip install --no-cache-dir -r tests/requirements.txt
scripts/test-db.sh
supabase db lint --local --level warning
```

Reset and fixtures are for the disposable local database only. Real OAuth credentials and production recovery are separate deployment prerequisites.
