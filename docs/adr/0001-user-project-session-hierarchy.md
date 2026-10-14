# ADR 0001: Use User → Project → Session as the Business Hierarchy

- **Status:** Accepted
- **Date:** 2026-06-30

## Context

Novel Vibe currently uses Project for novel ownership, Session for Chief Editor conversations, and Workspace inconsistently for both UI layout and skill configuration. This makes product naming and future ownership rules unclear.

## Decision

Use `User → Project → Session` as the complete business hierarchy. A Project represents one novel and owns documents, tasks, skills, memory and Sessions. Workspace remains a UI-only term. Rename `workspace_skills/workspace_id` to `project_skills/project_id`.

Do not add a Workspace or Organization entity for hypothetical collaboration. Future collaboration will add `project_members(project_id, user_id, role)` directly.

## Consequences

- Product, API and database terminology agree.
- Existing Project and Session foreign keys remain stable.
- Future team access changes authorization policy, not data ownership.
- UI component names containing Workspace may remain when they describe layout only.
