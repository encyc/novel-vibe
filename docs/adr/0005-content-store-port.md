# ADR 0005: Content Store Port and the Local-First Persistence Seam

- **Status:** Accepted
- **Date:** 2026-10-10
- **Scope:** `packages/novel-agents/lib/` storage layer
- **Related:** `docs/research/2026-10-10-local-first-and-open-source-research.md`（私有运维仓）(Phase 1)

## Context

Novel Vibe is moving toward a **local-first, cloud-optional** product: the same
agent core must run against InsForge Storage when hosted, and against the user's
own filesystem when self-hosted. The research pass established three facts that
shape this decision:

1. **The storage surface is narrow.** `StorageClient` exercises exactly five
   object verbs against `/api/storage/buckets/{bucket}/objects/{path}` (read,
   write, writeBytes, delete, deletePrefix). It is a low-cost seam to abstract.
2. **`list()` is a deliberate no-op.** The S3-backed client returns `[]` and
   documents that enumeration happens through `document_index`. `search()` is
   implemented on top of `list()`, so it is dead in production — `search_docs`
   reads the DB index instead. A filesystem-backed store, by contrast, *can*
   list for real.
3. **The blocking coupling is concrete types, not the transport.** Domain code
   depended on `StorageClient` the class (`ToolContext.storage`,
   `ToolContext.skillsStorage`), and construction was scattered across ten
   files, so there was no single place to choose a backend.

The database layer is a much larger and separate problem (a 165-method
`DbClient` facade with 315 call sites). This ADR deliberately decides **only**
the content-storage seam; the database port is deferred to Phase 2.

## Decision

**Introduce a `ContentStore` port and make the agent core depend on it.**

1. `lib/content-store.ts` owns the transport-free contract: the `ContentStore`
   interface plus the pure helpers every implementation shares
   (`sha256Content`, `isReservedDocumentPath`, `documentSnapshotPath`,
   `StorageObjectExistsError`, `writeContentAddressedSnapshot`,
   `searchByScanning`, `isMissingObjectError`).
2. `lib/storage.ts` becomes *the S3 implementation* and declares
   `implements ContentStore`.
3. `lib/fs-content-store.ts` is *the filesystem implementation*, rooted at a
   user-chosen directory.
4. **Listing capability is declared, not assumed.** `ContentStore` exposes
   `readonly supportsListing: boolean`. Callers must key off this flag rather
   than interpret an empty `list()` as "nothing exists" — the S3 store returns
   `[]` by design while the filesystem store returns real results.
5. **Snapshot and search semantics live in one place.** Both implementations
   delegate to the shared helpers so the 20-hit cap, the 200-character snippet
   rule, the content-addressed snapshot path, and the "refuse to overwrite a
   snapshot whose bytes disagree" rule cannot drift between backends.
6. **One backend decision point.** `createContentStore(scope)` in
   `lib/content-store-factory.ts` is the only place that chooses an
   implementation. `ContentStore` is a type-only dependency for domain code;
   `StorageClient` may only be referenced from the factory.
7. **One contract suite, run against every implementation.**
   `lib/content-store.contract.ts` exports `describeContentStoreContract(...)`,
   and both `lib/storage.test.ts` and `lib/fs-content-store.test.ts` run it.

## Consequences

- A second storage backend can be added without touching agent tools, the
  orchestrator, or the HTTP routes — the Phase 3 local-mode switch is a change
  inside the factory plus configuration.
- The `supportsListing` flag makes an existing asymmetry honest. Local mode
  gains real enumeration and real keyword search "for free"; hosted mode keeps
  its DB-index-backed behaviour unchanged.
- Both implementations are now bound by one contract test suite, so a fix or a
  behaviour change applied to one backend must be applied to the other or CI
  fails. This is the intended cost: it is what prevents "SQLite-only" or
  "S3-only" drift later.
- `StorageClient` and its helpers remain exported from `lib/storage.ts`, so
  existing importers keep working during the transition. New code should import
  from `lib/content-store.ts`.
- Turning on local mode still requires Phase 2 (database port) and Phase 3
  (identity, model-access policy). This ADR unblocks them; it does not complete
  local-first by itself.

## Open decisions (not settled here)

These are product decisions recorded in the research report (D1–D10) and are
explicitly **out of scope** for this ADR: the open-source license, single-repo
vs dual-repo, the local database choice, whether local mode requires an account,
and whether BYOK stays gated behind membership.
