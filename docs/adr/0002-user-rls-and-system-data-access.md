# ADR 0002: Separate User-scoped RLS Access from System Access

- **Status:** Accepted
- **Date:** 2026-06-30

## Context

Novel Vibe currently verifies JWT identity in the Agent Server but accesses PostgREST with a postgres-role JWT. The `novel.*` tables do not enforce RLS, so application filters are the primary isolation boundary. InsForge's end-user database convention is JWT context plus PostgreSQL RLS.

## Decision

Browser-triggered work uses the user's verified InsForge JWT through `UserDbClient` and user-scoped Storage clients. PostgreSQL RLS enforces Project ownership on Project rows and all descendants. Application services keep ownership and lifecycle checks to produce useful domain errors.

Workers, migrations, built-in skill installation and purge operations use a separately constructed `SystemDbClient`. System credentials must never be reachable through request-scoped Agent tools.

## Consequences

- A missed application filter does not expose another user's rows.
- Request and worker repositories must be separated explicitly.
- Existing Storage ownership requires audit/backfill before switching credentials.
- Real PostgreSQL two-user tests are mandatory; mocked query tests are insufficient.
