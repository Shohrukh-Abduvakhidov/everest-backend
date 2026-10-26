---
project: EVEREST Backend
milestone: M02F-B
status: done
branch: feat/m02f-b-auth-protection
base_commit: 1dbce804
completed_at: 2026-10-26
---

# M02F-B completion handoff

## Delivered

- PostgreSQL-backed IP/action throttles for sensitive public authentication and administrator mutations.
- Five-attempt, 15-minute password-account lockout using HMAC-derived normalized-phone keys; success clears the counter.
- Stable `429 AUTH_RATE_LIMITED` with `Retry-After` and audit events for known-account login failures.
- Random session-bound CSRF tokens stored as hashes and returned in the readable `everest_csrf` cookie.
- Exact allowed-origin plus `X-CSRF-Token` checks for cookie-authenticated mutations; bearer and public auth/recovery routes remain exempt.
- One reversible migration: `20261026020000000_add-auth-protection-state.js`.

## Verification

- `npm test` passed 62 authentication tests, eight schema-integrity cases, migration-source integrity, and server lifecycle.
- Catalog verification passed: 85 tables, 668 columns, 159 foreign keys, 301 indexes, 16 migrations, and 65 identity columns.
- Focused tests passed atomic concurrent failures, lockout expiry/reset, stable retry responses, and valid/missing/invalid/cross-session CSRF behavior.
- Disposable rollback was not run because `everest_app` lacks `CREATEDB` (`42501`); no rollback ran against `everest_db`.

## Next milestone

M03 is Planned: implement safe self-profile and onboarding APIs with ownership, validation, asset authorization, and field redaction.
