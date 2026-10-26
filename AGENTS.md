# EVEREST Backend — Shared Instructions for Codex and Claude Code

Version: 1.2. Updated: 25 October 2026.

Read documentation.md, docs/progress.md when present, package.json, lockfile and relevant migrations before editing. Follow the everest-backend skill in the current agent's project discovery folder. If missing, use the portable files in documentation.md.

## Required stack and structure

- Use JavaScript, Express, PostgreSQL, pg and node-pg-migrate.
- Preserve src/app.js, src/server.js and configs/, routes/, controllers/, services/, middleware/, migrations/, jobs/, prompts/, uploads/ and utils/.
- Add the mandatory src/repositories/ layer. This supersedes older instructions permitting SQL in services or optional repositories.
- Keep kebab-case filenames and snake_case SQL identifiers.
- Inspect actual code for CommonJS/ESM, functions/classes, exports, formatting and response conventions. A prose tree does not establish exact syntax.
- For an empty project without examples, documentation.md proposes JavaScript/CommonJS as a provisional default. Record that choice.
- Do not introduce TypeScript, an ORM, NestJS, a feature-folder rewrite, DI container or generic base-repository framework without the user's request.

## Mandatory persistence boundary

- Use route -> middleware -> controller -> service -> repository -> pg.
- Routes wire handlers; controllers handle HTTP; services own business rules and transaction scope; repositories own application SQL and persistence.
- Put every application query, including lookups, health checks, statistics, writes and row/advisory locks, under src/repositories/.
- Do not embed SQL or call pool.query/client.query in routes, controllers, services, middleware, providers or jobs. They call services/repositories through the appropriate layer.
- configs/db.js constructs the pg.Pool. src/migrations owns schema SQL. Tests and authorized operational scripts may use separate fixture/maintenance SQL.
- Implement withTransaction in repositories/transaction-repository.js: acquire one client, BEGIN, callback, COMMIT/ROLLBACK and finally release.
- Services choose the atomic business operation and pass the callback's SAME client to every participating repository. Entity repositories must not begin/commit their own transaction, acquire another connection or release the caller's client.
- Require an explicit transaction client for transaction-only write/lock methods. Do not silently fall back to pool.query within an atomic operation.
- Parameterize values; allowlist dynamic identifiers/sorts. Never execute arbitrary AI-generated SQL.
- Place notification/statistics repositories under src/repositories/notifications/ and src/repositories/stats/. Adapt affected existing modules without unrelated wholesale moves.

## Mandatory CRM runtime style

- Use native ESM, no semicolons, single quotes, three-space indentation and readable multiline formatting.
- Route modules export one configured router by default and import explicit controller functions. Do not build ordinary router factory graphs.
- Controllers are direct top-level named async exports ending in `Controller`. They use exactly `req, res, next`, wrap work in `try/catch`, and forward failures with `next(error)`.
- Business services are direct top-level named async exports ending in `Service`; the real flow lives in those functions, not in factory-created singleton objects or delegating wrappers.
- Ordinary routes, controllers and business services must not use `create...Router`, `create...Controller`, `create...Service`, mutable dependency setters or singleton wrapper chains.
- Optional function dependency parameters are allowed only where tests need controlled repositories, transactions, clocks or providers. Real external-provider adapters and isolated application/test constructors may retain factories when justified.
- SQL remains exclusively in repositories and migrations. Services own transaction orchestration and pass the same client to transaction-only repository methods.

## Startup, migrations and scope

- Use one bounded pg.Pool per process. Importing app.js must not listen, migrate, start workers or mutate schema.
- Keep JavaScript node-pg-migrate files in src/migrations. Preserve applied migrations and existing data.
- The complete SQL is a reference baseline, not a script to rerun after existing auth migrations. Inspect migration history before reconciliation.
- Implement only the requested increment; do not generate all future CRUD endpoints or 81 placeholder services.
- Start workers explicitly. Use PostgreSQL locks/leases and idempotent processing across PM2 processes.
- Do not copy production CRM .env, credentials or dumps; do not deploy from a documentation-only request.

## EVEREST invariants

- One center; no EduCRM integration, built-in videoconferencing, group_courses or question_versions.
- Groups organize people and announcements and never issue course access.
- An authorized administrator individually grants course_enrollments and separate module_access_grants. Validate both grants, dates and revocation for protected content.
- Keep one users.id across phone/password/Telegram. Verify ownership/signatures; never merge by name or unverified phone.
- Validate active account, live session, action permission and resource scope. A JWT signature alone does not enforce session revocation.
- Author correctness only in question_answer_keys. Unverified imports remain draft; published questions/tests are immutable.
- Keep keys, grading snapshots, OTPs, password/refresh hashes and secrets out of student responses and logs.
- Make attempt finalization, bonus operations and AI reservations atomic/idempotent. Bonus packages do not override the AI cash budget.
- Do not silently settle unresolved attempt scope, reveal timing, scoring, ranking, expiry or provider choices.

## Shared-agent continuation and verification

- AGENTS.md is the shared rule source. CLAUDE.md imports it with @AGENTS.md instead of maintaining a competing architecture.
- Keep portable skill files identical in .agents/skills/everest-backend/ and .claude/skills/everest-backend/ when using copies.
- Before continuing another agent's work, read docs/progress.md and inspect actual git status/diff, code and applied migrations. Never reinitialize, discard unrelated changes or recreate existing tables based on an old chat.
- Update documentation.md, docs/api.md, docs/decisions.md and docs/progress.md with implemented behavior, tested commands/results, unfinished work and the next concrete task.
- Validate inputs and use explicit safe DTOs/stable errors. Test relevant database constraints, access denials, rollback, concurrency and idempotency in a disposable database.
- Distinguish test doubles, syntax checks and live integrations. Report unrun checks accurately and never claim a backend was implemented during documentation-only work.

## Session startup protocol

Every coding session must:

1. Inspect `git status`.
2. Inspect the current branch.
3. Inspect the last five commits.
4. Read `ROADMAP.md`.
5. Read `docs/handoffs/current.md`.
6. Read `docs/architecture.md`.
7. Read `docs/progress.md` and `docs/decisions.md`.
8. Inspect the actual code for the current milestone.
9. Compare documentation with the implementation and correct mismatches first.
10. Work only on the selected milestone.

## Session completion protocol

Every coding session must:

1. Run relevant tests.
2. Run `migrate:up` if migrations changed.
3. Inspect `git diff` and `git status`.
4. Update `ROADMAP.md` only from verified evidence.
5. Update `docs/progress.md`.
6. Update `docs/decisions.md` when a decision was made.
7. Update `docs/api.md` when an API changed.
8. Update `docs/architecture.md` when architecture changed.
9. Replace `docs/handoffs/current.md` with the current verified handoff.
10. Report blockers honestly.
11. Never expose secrets.
12. Never claim untested work passed.
