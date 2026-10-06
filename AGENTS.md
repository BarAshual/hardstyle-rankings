# Repository Guidelines

## Read Before Working

This repository defines a private annual Hardstyle ranking app for approximately 15 friends. Before implementing a feature, inspect the relevant context:

- [Product specification](docs/product-spec.md): behavior, lifecycle, secrecy, and scope.
- [Architecture](docs/architecture.md): trust boundaries and voting reliability.
- [Data model](docs/data-model.md): entities and integrity requirements.
- [Decisions](docs/decisions.md): accepted choices and unresolved questions.

## Non-negotiable Rules

- Keep all group preferences secret until `REVEAL`, including from application admins. `LOCKED` is still secret.
- Validate season invitations against authenticated Google email server-side; a forwarded link is insufficient.
- Preserve votes as catalogs grow; derive completion and Super Like usage. Allow only authorized, recorded allowance increases during `VOTING`.
- Prioritize durable votes, database integrity, reliable recovery, simple operations, and explicit security boundaries before UI work. Enforce rules in Postgres/RLS where practical, not only in clients.
- Do not silently change established architecture. Call out conflicts with `docs/decisions.md` and make proposed changes explicit and reviewable before implementing them.
- Keep relevant docs synchronized with approved behavior and architecture changes. Distinguish accepted product/architecture decisions, implementation proposals, and open questions. Integer vote versioning is required; see the voting contract in docs/database-foundation.md.
- Keep architecture manageable by one developer. Do not add unnecessary infrastructure or prematurely implement scoring. The first database foundation excludes results, aggregation APIs, snapshots, and reveal controls.

## Development and Validation

The database foundation uses versioned Supabase migrations and Python database integration tests. Follow docs/database-foundation.md for setup, reset, and test commands. The frontend uses Vite/React/TypeScript; follow docs/frontend.md. Run npm test, npm run typecheck, npm run lint, and npm run build for frontend work; rerun database integration tests for database contract changes. Keep migrations in source control.

After modifications, run relevant tests and typechecks when available. For database work, verify authorization, secrecy, constraints, concurrency, retries, and audit behavior. Report checks performed and anything unavailable. Review documentation links and whitespace for documentation changes.

## Security and Git

- Never commit secrets or `.env` values. Use placeholder-only examples.
- Keep privileged Supabase credentials out of browser code and public outputs.
- Do not make Git commits unless the user explicitly requests them.
- Keep changes focused; summarize behavior, validation, and unresolved decisions for review.
