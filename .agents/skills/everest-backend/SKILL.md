---
name: everest-backend
description: Develop and review EVEREST backend in Shohrukh's CRM style using JavaScript, Express, pg and node-pg-migrate. Use for EVEREST routes, controllers, services, mandatory repositories, SQL transactions, migrations, access control, authentication, question imports, tests, jobs and API documentation. Preserve the existing layer-based src structure; do not migrate to TypeScript, an ORM or feature folders without the user's request.
---

# EVEREST Backend

## Establish context

Read repository AGENTS.md, CLAUDE.md when present, documentation.md, docs/progress.md when present, package.json, lockfile and relevant migrations. For project invariants and defaults, read [project-rules.md](references/project-rules.md). When working on external integrations or migration tooling, consult the installed version and current official documentation.

Inspect representative route, controller, service, repository, configs/db.js and one migration before changing code. If only a prose CRM description is available, distinguish observed structure from unknown syntax. Follow actual code for CommonJS/ESM, named exports, indentation, quotes, function/class style and response shape. For an empty repository, use the documented JavaScript/CommonJS fallback and record it as a new choice, not an inferred fact about CRM.

## Preserve structure

Keep src/app.js and src/server.js; configs/, routes/, controllers/, services/, repositories/, middleware/, migrations/, jobs/, prompts/, uploads/, utils/. Keep kebab-case filenames. Use snake_case SQL identifiers. Add only files needed for the current increment, not placeholders.

Keep business rules and transaction scope in services, HTTP handling in controllers and wiring in routes. Repositories are mandatory for all application SQL. Do not call pool.query/client.query or embed SQL outside repositories. Keep connection construction in configs/db.js and schema SQL in migrations.

## Follow Shohrukh's CRM runtime style

- Use native ESM, single quotes, no semicolons, three-space indentation, and readable multiline formatting.
- Keep route modules configured through a default router export and wire explicit controller functions.
- Name Express controllers with a `Controller` suffix and use exactly `req, res, next` with `try/catch/next`.
- Name direct async business operations with a `Service` suffix and keep the real business flow in those functions.
- Avoid singleton wrapper chains and runtime factories. Retain a factory only for a concrete provider or test dependency-injection requirement and document the reason.
- Keep business validation and transaction scope in services. Keep all SQL in repositories and pass an existing transaction client into transaction-only repository methods.
- Preserve PostgreSQL `BIGINT` identifiers as decimal strings and never coerce entity identifiers through JavaScript `Number`.

## Implement one increment

1. Read current requirements and schema for the affected module.
2. Define validation, permissions, resource scope, state transitions and response.
3. Write node-pg-migrate JavaScript migrations; preserve applied migrations and data.
4. Implement route -> controller -> service -> repository -> pg.
5. Implement withTransaction with one acquired client, BEGIN, callback, COMMIT/ROLLBACK and release in finally; pass the same client to participating repositories.
6. Serialize competing mutations and apply idempotency where required.
7. Run relevant checks against a disposable test database and report accurately.
8. Update documentation and continuity records.

## Enforce data and access rules

Use one users.id for phone/password/Telegram identity. Validate active account, live session, role permission and resource scope separately. Keep groups independent from courses. Administrators grant course_enrollments and module_access_grants separately. Keep published question/test content immutable and correctness only in question_answer_keys. Lock and validate attempts before mutation. Keep bonus and AI journals append-only and reserve budgets atomically.

## Check implementation details

Parameterize SQL values and allowlist dynamic identifiers. Validate inputs and map database failures to stable errors without private data. Preserve NUMERIC/BIGINT precision. Keep migrations out of application startup. Do not introduce excluded integrations or architecture.

## Completion report

Keep AGENTS.md shared and CLAUDE.md as its adapter. Install matching skill files for both agents and synchronize copies. State changes, verification results, blockers and next work accurately.

