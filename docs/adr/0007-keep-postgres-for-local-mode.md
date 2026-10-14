# ADR 0007: Keep PostgreSQL for local mode

- **Status:** Accepted
- **Date:** 2026-10-10
- **Supersedes:** the "Phase 2 — database port to SQLite" plan in
  `docs/research/2026-10-10-local-first-and-open-source-research.md`（私有运维仓）§5/§6
- **Related:** ADR 0005 (ContentStore), ADR 0006 (policy ports)

## Context

The research report assumed local-first mode would need the relational layer
replaced — SQLite for projects, sessions, document indexes, version history and
background queues — and scoped that as Phase 2 (4–6 weeks, the single largest
item in the plan). Before starting it we measured what *keeping* PostgreSQL
actually costs a self-hoster, on a locally running stack:

| Container | Image | Idle RAM |
|---|---|---:|
| postgres | 1.46 GB | 96 MiB |
| postgrest | 621 MB | 167 MiB |
| insforge | 394 MB | 418 MiB |
| deno (edge-function runtime) | 220 MB | 69 MiB |
| **total** | **≈2.7 GB** | **≈750 MiB** |

The user-facing action is a single `docker compose up -d`
(`scripts/start.sh:131`); the prerequisite is Docker. Two findings shaped the
decision:

1. **No object-storage service is needed.** `InsForge/docker-compose.yml:148`
   sets `STORAGE_DIR=/insforge-storage`, a local volume — so the Markdown source
   of truth already lives on the user's own disk. No MinIO/S3.
2. **The expensive part of Phase 2 was never PostgreSQL.** It was the semantics
   PostgreSQL carries: 86 RLS policies across 14 migrations, 8
   `FOR UPDATE SKIP LOCKED` queue sites, 4 PL/pgSQL functions (including the
   atomic `acquire_session_lease`), 76 `jsonb` columns, 34 `gen_random_uuid`
   calls. Keeping PostgreSQL keeps all of it for free; SQLite would mean
   reinventing each one in the application layer — in the exact areas
   (`AGENTS.md`: Session persistence, billing, delete approval) that are marked
   correctness-sensitive.

The honest cost is not the 750 MiB: it is "you must install Docker". On
macOS/Windows the Docker engine itself needs a Linux VM (measured ceiling on the
development machine: 7.65 GiB).

## Decision

**Local-first mode keeps PostgreSQL (and the InsForge stack). Phase 2 as
originally scoped — replacing the relational layer with SQLite — is cancelled.**

The rationale is ordering, not storage preference. The unvalidated risk in this
project is the *local-mode product experience*: whether no-login operation works,
whether BYOK alone can drive all seven agents, whether the project layout is
something a user can live with. Those questions can be answered in about a week
with PostgreSQL kept, and they are the same questions a SQLite port would still
leave unanswered after six weeks of work.

## Consequences

- **Roughly 4–6 weeks of planned work is removed**, along with the permanent cost
  of maintaining two persistence implementations and proving they agree.
- **No dual-implementation contract burden** for the database layer. Only the
  content store carries two implementations (ADR 0005), because that seam is
  narrow.
- **Local mode requires Docker.** This is an accepted product constraint, not an
  oversight. It narrows the audience to users who can run `docker compose`. If
  real users report that as the blocker, revisit with evidence — the SQLite
  option does not disappear, it just moves behind that evidence.
- **"Local-first" is satisfied but should be made legible.** The Markdown already
  lives in a local volume, but inside Docker's managed storage, where a user
  cannot see or edit it directly. Recommended cheap follow-up: bind-mount
  `STORAGE_DIR` (and optionally the Postgres data directory) to a user-chosen
  visible path at first run, so "your novels are files on your disk" is literally
  true and inspectable. This is packaging, not architecture.
- **What remains for local mode** is the Phase 3 work the report already
  identified: a local identity provider (no login), un-gating BYOK from
  membership, a model-access policy seam, and a single-command startup that does
  not require understanding InsForge.
- The research report's §5 Phase 2 section is now historical; its Phase 3 section
  becomes the next active step.
