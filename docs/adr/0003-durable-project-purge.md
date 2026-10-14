# ADR 0003: Permanently Delete Projects with a Durable Workflow

- **Status:** Accepted
- **Date:** 2026-06-30

## Context

Permanent Project deletion spans PostgreSQL, InsForge Storage and external project memory. No transaction can atomically commit across all three. Deleting the database row first would remove the authoritative inventory needed to clean up external data.

## Decision

Move Projects to a 30-day trash state before deletion. Permanent deletion creates a durable, idempotent `project_deletion_jobs` state machine:

```text
pending → excluding_memory → deleting_storage
        → deleting_database → complete | failed
```

The worker freezes the Project, establishes memory exclusions, deletes Storage, and deletes database content last. A processing Session blocks trash and deletion. Once external deletion starts, restoration is prohibited.

The Job retains its immutable target UUID without a blocking Project foreign key so it can record completion after the Project row is gone.

## Consequences

- Partial failures are observable and retryable.
- Permanent deletion becomes asynchronous.
- Billing/audit rows survive Project deletion; resource foreign keys use `ON DELETE SET NULL` where required.
- Cleanup stages require metrics, backoff and explicit indeterminate-enumeration handling.
