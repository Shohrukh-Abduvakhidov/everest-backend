# EVEREST Backend — Architecture and Instructions for Codex and Claude Code

Version: 1.1. Updated: 25 October 2026.
Canonical repository path: root `documentation.md`.

## Contents

1. Purpose and sources of truth
2. Confirmed CRM conventions and unknown details
3. Stack and architecture boundaries
4. Required project structure
5. Mandatory repositories and layer responsibilities
6. PostgreSQL connection management
7. Transactions, locking and concurrency
8. JavaScript migrations with node-pg-migrate
9. Environment, startup and shutdown
10. HTTP API, validation and errors
11. Users and authentication
12. Groups, courses and individual access
13. Question bank and book imports
14. Assessments, attempts and grading
15. AI, bonuses, notifications and workers
16. Verification and acceptance checks
17. Implementation stages
18. Shared Codex / Claude Code workflow
19. Open product decisions
20. Official references and skill installation
21. Portable skill files

## 1. Purpose and sources of truth

Build the EVEREST backend using Shohrukh's existing CRM organization: JavaScript, Express, PostgreSQL, pg and node-pg-migrate. Preserve the layer-based layout and add the mandatory repositories layer explicitly requested on 24 October 2026.

The request flow is:

`route -> middleware -> controller -> service -> repository -> pg -> PostgreSQL`

This rule supersedes the earlier documentation that allowed SQL directly in services or made repositories optional. Do not preserve that obsolete exception when generating new code or continuing existing EVEREST work.

EVEREST is a closed learning platform for one learning center: courses, recorded lessons, modules, NCT assessments, groups, AI assistance and bonuses. It is a separate backend. The old CRM is a style reference, not a source of production credentials, financial tables or academy synchronization requirements.

Apply sources in this order:

1. The user's latest explicit EVEREST decisions.
2. Root AGENTS.md and this documentation for required project conventions.
3. Actual repository code, package.json, lockfile, migrations and database catalog for implementation state and syntax.
4. Root `schema_tables.md` and applied migrations as the complete database reference.
5. Official documentation matching the installed library versions.

If current code uses the old service-SQL pattern, treat that as existing implementation state, not permission to disregard the new repository requirement. Convert the affected feature incrementally and avoid unrelated rewrites. If requirements and the reference schema conflict, state the discrepancy and implement an explicit migration; never silently change either source.

Downloaded SQL does not establish that a database, API, server or deployment exists. Only mark behavior as implemented after inspecting code and performing relevant checks.

Keep these documents distinct:

- documentation.md: detailed backend specification and workflow;
- AGENTS.md: concise shared rules for both coding agents;
- CLAUDE.md: a small adapter importing AGENTS.md;
- schema_tables.md: current complete baseline schema contract;
- future DBML/schema exports: planned artifacts created only when requested;
- future book-import documentation: planned separately when import work begins;
- docs/decisions.md: dated decisions and replaced assumptions;
- docs/api.md: implemented API contracts, with proposed endpoints clearly labeled;
- docs/progress.md: practical implementation and handoff state.

## 2. Confirmed CRM conventions and unknown details

The user supplied a prose architecture description, not the complete CRM source repository. Confirmed characteristics are JavaScript, Express, PostgreSQL, pg, node-pg-migrate, app.js/server.js, layer-based folders and kebab-case entity filenames. The CRM uses bcrypt, jsonwebtoken, multer, web-push, node-cron, exceljs and date-fns. Some notification/statistics modules already use repositories.

The user's new rule makes repositories mandatory across EVEREST, under src/repositories/. Do not preserve optional or service-local SQL as a default merely because the historical CRM used it.

Unknown details include CommonJS versus ESM, functions versus class instances, export conventions, indentation, quotes, response envelopes, actual environment variable names and database helper signatures. Do not claim to have verified these from a folder tree.

When source examples are available, inspect package.json, app.js/server.js, configs/db.js, configs/env.js, representative route/controller/service/repository files and a migration. Preserve actual syntax and formatting except where the user has explicitly changed an architectural rule.

For a new empty repository without examples, use JavaScript/CommonJS, async/await, ordinary functions, kebab-case filenames and SQL repositories as provisional defaults. Record this choice; it is not an established fact about the old CRM.

## 3. Stack and architecture boundaries

Required foundation: Express, PostgreSQL, pg and node-pg-migrate. Preserve npm/package-lock.json if following the supplied CRM setup. Do not replace the package manager or upgrade all dependencies while performing an unrelated task.

Use a modular monolith with the existing layer-based folders. A separate worker may share the database when background work is introduced. Redis, Kafka, Elasticsearch and microservices are not initial requirements.

Do not introduce TypeScript, an ORM, NestJS, a dependency-injection container, CQRS or a feature-folder rewrite without an explicit request. Adding repositories does not require any of those changes.

Excluded from current scope: EduCRM integration, built-in video calls/WebRTC, multi-tenant academy_id/tenant_id infrastructure, question_versions and group_courses. Do not restore these from older discussions.

Select compatible stable Node.js/library versions during initialization, verify engines and retain the lockfile. Do not install an alpha release just because its documentation appeared in search. If the project already exists, inspect its installed versions first.

## 4. Required project structure

The following is the target organization. Create future feature files only when implementing that feature; do not generate empty files for every entity.

```text
everest-backend/
  package.json
  package-lock.json
  .env.example
  .gitignore
  AGENTS.md
  CLAUDE.md
  documentation.md
  .agents/skills/everest-backend/
    SKILL.md
    references/project-rules.md
  .claude/skills/everest-backend/
    SKILL.md
    references/project-rules.md
  .github/workflows/deploy.yml  # planned with deployment
  docs/
    architecture.md
    decisions.md
    api.md
    progress.md
  src/
    app.js
    server.js
    configs/
      db.js
      env.js
      migrate.js
      error-handler.js
      notifications-templates.js
    routes/
      index.js
      auth.js
      users.js
      groups.js
      courses.js
      questions.js
      tests.js
    controllers/
      auth-controller.js
      users-controller.js
      groups-controller.js
      courses-controller.js
      course-access-controller.js
      questions-controller.js
      tests-controller.js
      attempts-controller.js
    services/
      auth-service.js
      users-service.js
      groups-service.js
      courses-service.js
      course-access-service.js
      questions-service.js
      question-import-service.js
      tests-service.js
      attempts-service.js
      grading-service.js
      auth/providers/sms-provider.js
      auth/providers/telegram-provider.js
      ai/ai-service.js
      ai/providers/ai-provider.js
      notifications/notifications-service.js
      notifications/providers/push-provider.js
      notifications/providers/telegram-provider.js
      stats/stats-service.js
    repositories/
      transaction-repository.js
      health-repository.js
      auth-repository.js
      users-repository.js
      groups-repository.js
      courses-repository.js
      course-access-repository.js
      questions-repository.js
      question-import-repository.js
      tests-repository.js
      attempts-repository.js
      audit-repository.js
      notifications/notifications-repository.js
      stats/stats-repository.js
    middleware/
      auth-middleware.js
      permissions-middleware.js
      validate-middleware.js
      uploads.js
    migrations/
      <timestamp>_create-auth-tables.js
      <timestamp>_create-course-access-tables.js
    jobs/                 # approved location; create with worker implementation
    prompts/              # approved location; create with prompt implementation
    uploads/              # approved location; create with upload implementation
    utils/
      async-handler.js
      app-error.js
      excel/
  tests/
    integration/
    unit/
```

This is a target tree, not a claim that every path exists. Git does not preserve empty directories; `src/jobs`, `src/prompts`, and `src/uploads` are approved locations that will be created only with their corresponding features. Their current absence is not an architecture violation. Preserve configs/error-handler.js from the supplied structure unless actual project code has an established different location. The mandatory repositories layer is not a reason for wholesale reorganization.

For new EVEREST features, notification/statistics repositories belong under src/repositories/, not under services/.../repositories/. When migrating existing implementation, update imports for the affected module and avoid parallel competing persistence layers.

Do not add ai-sql-prompt.js or sql-guard.js solely because they existed in CRM. EVEREST's AI is not permitted to execute arbitrary SQL. Do not introduce groq-client.js until Groq is actually selected; use the chosen provider's adapter instead.

Local uploads/images may support development. Keep production videos and protected files outside tracked application source on configured storage. PostgreSQL stores metadata and storage_key. Do not expose protected uploads wholesale through express.static.

## 5. Mandatory repositories and layer responsibilities

| Layer | Responsibility | Forbidden responsibility |
|---|---|---|
| routes | Declare URLs and wire middleware/controllers | SQL or business calculations |
| middleware | Validate session/input and perform appropriate preliminary permission checks through services | Direct queries or trusting a body-supplied role |
| controllers | Receive validated input, call a service and produce the HTTP response | SQL, transaction commands or complex business workflows |
| services | Apply business rules, authorize resources, compose repositories and choose atomic transaction scope | SQL strings, pool.query, client.query or Express req/res coupling |
| repositories | Execute parameterized persistence queries, row/advisory locks and return persistence results | HTTP responses, Express dependencies or business authorization decisions |
| transaction-repository.js | Acquire one client, BEGIN, callback, COMMIT/ROLLBACK and release | Domain-specific decisions or independent nested transactions |
| configs/db.js | Construct and export the process's pg.Pool | Business queries or automatic migrations |
| migrations | Define versioned schema changes and database functions/triggers | Per-request schema updates |
| jobs/providers | Trigger services or communicate with external providers | A second SQL/business implementation |

Mandatory rule: every application SQL statement belongs in src/repositories/. This includes read-only lookups, readiness SELECT 1, session lookup, grants, FOR UPDATE, advisory locks, aggregate statistics and journal writes. Schema SQL belongs in src/migrations. Test fixtures and explicitly authorized operational scripts may use SQL for their separate purpose; this does not permit application services to query directly.

Services decide the business transaction boundary. The transaction repository implements the low-level SQL and client lifecycle. Entity repositories receive that client and never independently BEGIN/COMMIT/ROLLBACK, acquire a second connection or release the caller's client.

Repositories can offer simple nontransactional reads with db = pool. For operations that participate in an atomic workflow, require or explicitly pass the transaction client. A forgotten client argument must not silently move part of a transaction onto the pool. Prefer required client parameters on transaction-only write/lock methods.

Do not build a universal base repository, ORM imitation or generic arbitrary-table CRUD framework. Use clear entity/domain operations such as findUserById, lockEnrollment, createModuleGrant and appendAuditEvent. One repository can cover several closely related tables; 81 tables do not imply 81 public CRUD endpoints.

## 6. PostgreSQL connection management

Construct one pg.Pool per process in configs/db.js. HTTP and worker processes have separate bounded pools. Size them against the total number of processes and PostgreSQL max_connections, rather than assigning a large pool to every PM2 worker.

Use one explicit configuration method: DATABASE_URL or the agreed DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD fields. If both are supported, define clear precedence and reject contradictory configuration.

Illustrative CommonJS connection setup; env field names are proposed for a new project:

```js
// src/configs/db.js
const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.dbPoolMax,
  connectionTimeoutMillis: env.dbConnectionTimeoutMs,
  idleTimeoutMillis: env.dbIdleTimeoutMs,
});

pool.on('error', (error) => {
  console.error('Unexpected idle database connection error', {
    code: error.code,
  });
});

module.exports = pool;
```

Configure TLS according to actual hosting and certificates. Do not universally disable certificate validation with rejectUnauthorized=false. This is an architectural example, not an already implemented env/logger module.

A repository owns application queries:

```js
// src/repositories/users-repository.js
const pool = require('../configs/db');

async function findUserById(userId, db = pool) {
  const result = await db.query(
    'SELECT id, status, onboarding_completed_at FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = { findUserById };
```

The service calls findUserById instead of repeating this SQL. Keep public DTOs explicit: a safe query does not automatically establish a safe response, and a broad persistence row must not be serialized wholesale.

Parameterize values with $1/$2. Parameters do not substitute table names, column names or ORDER BY identifiers; map dynamic sorting through an allowlist. Never concatenate request text into SQL or execute an AI-generated SQL string.

Preserve NUMERIC/BIGINT precision. Do not globally convert all numeric strings to Number. Define API serialization for scores, money and large counters. Use TIMESTAMPTZ for absolute timestamps and Asia/Dushanbe as the proposed profile default.

## 7. Transactions, locking and concurrency

All transaction statements and queries must use the same acquired pg client. BEGIN on one connection followed by pool.query on others is not a transaction.

```js
// src/repositories/transaction-repository.js
const pool = require('../configs/db');

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Database rollback failed', { code: rollbackError.code });
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
```

A service composes repository operations without embedding SQL:

```js
// Illustrative service composition, not a complete access endpoint.
const { withTransaction } = require('../repositories/transaction-repository');
const accessRepository = require('../repositories/course-access-repository');
const auditRepository = require('../repositories/audit-repository');

async function grantModuleAccess(input, actor) {
  requireAdministrator(actor);
  validateGrantInput(input);

  return withTransaction(async (client) => {
    const enrollment = await accessRepository.lockEnrollment(
      input.userId,
      input.courseId,
      client
    );
    requireEffectiveEnrollment(enrollment);

    const module = await accessRepository.findModuleInCourse(
      input.moduleId,
      input.courseId,
      client
    );
    requireExistingModule(module);

    const grant = await accessRepository.saveExplicitModuleGrant(
      input,
      actor.id,
      client
    );
    await auditRepository.appendModuleGrantEvent(actor.id, grant, client);
    return toGrantDto(grant);
  });
}

module.exports = { grantModuleAccess };
```

The validation, authorization, repository methods and DTO helpers above must be implemented and checked against the actual schema; the example does not claim they already exist. saveExplicitModuleGrant must obey the selected policy for existing, expired or revoked grants. It must include required fields such as id and granted_by and use the real UNIQUE(user_id,module_id), not invent a different ON CONFLICT target.

Use row/advisory locks and constraints for competing mutations. Put locking SQL in repositories and lock rows in a consistent documented order. An in-memory Node.js mutex does not coordinate PM2 processes. Repositories perform persistence; the service interprets a missing row or expired grant as a business outcome.

The transaction repository alone releases the client. Entity repositories do not acquire another connection during an outer transaction. Do not automatically start nested BEGIN commands; compose using the caller's client, or design explicit savepoints when justified.

Keep transactions short. Do not hold database locks while waiting for a paid AI request, SMS delivery or video processing. Persist the required operation/reservation, perform the external call, then persist its outcome. Unknown timeouts require reconciliation; blind retries can duplicate charges or messages.

## 8. JavaScript migrations with node-pg-migrate

Keep migrations in src/migrations using JavaScript compatible with the project's chosen module system and installed migration tool version. Preserve the existing configs/migrate.js/package.json convention if present.

For a new project, a possible npm script is:

```json
{"scripts":{"migrate":"node-pg-migrate --migrations-dir src/migrations"}}
```

Verify command flags with the installed stable version before committing configuration. Ensure DATABASE_URL is loaded into the migration process itself; dotenv loading in a different server process does not configure the CLI.

```bash
npm run migrate -- create create-roles -j js
npm run migrate -- up
npm run migrate -- down
```

Use down only where rollback is safe, normally a disposable test database. Do not automatically run destructive production rollbacks. Verify dry-run semantics against the chosen tool version rather than assuming flags or guarantees.

An illustrative roles migration, not a command to recreate an existing table:

```js
exports.up = (pgm) => {
  pgm.createTable('roles', {
    id: { type: 'bigint', primaryKey: true, generated: 'BY DEFAULT AS IDENTITY' },
    code: { type: 'varchar(24)', notNull: true, unique: true },
  });
  pgm.sql(`
    ALTER TABLE roles ADD CONSTRAINT roles_code_check
    CHECK (code IN ('owner', 'admin', 'teacher', 'student'));
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('roles');
};
```

Rules:

- Never edit already applied migrations to change a live database; create a new migration.
- Do not replace migrations with CREATE TABLE executed at server startup.
- Treat full SQL as a reference for a clean database. Convert the required portions into ordered migrations while preserving fields, constraints, indexes, composite FKs, functions and triggers.
- Do not run the complete baseline after the old auth SQL in the same database.
- Use pgm.sql or the migration API for PostgreSQL functions/triggers. Diagram-parser limitations are not grounds to remove database protections; use DBML for the diagram.
- Keep internal entity identifiers as PostgreSQL-generated `BIGINT` identities and their references as `BIGINT`; preserve snake_case names and never renumber rows after deletion.
- Preserve the reference role IDs when seeding the four roles; do not bootstrap privileged users from untrusted input.
- Test clean up, safe rollback of the increment and reapplication in a disposable database with the intended test URL.
- If deployment omits dev dependencies, provide node-pg-migrate in a migration stage or runtime dependencies where needed.
- Run deploy migrations once under the migration tool's locking mechanism, not once per PM2 HTTP worker.
- For an existing database, inspect catalog and migration history before reconciliation. Do not hide incompatible schemas behind CREATE IF NOT EXISTS everywhere.

Application repositories must not perform schema migrations during an HTTP request.

## 9. Environment, startup and shutdown

Create .env.example and keep .env, uploads, backups and secrets out of Git. Never copy the production CRM environment, database dumps or deployment credentials.

Proposed new-project names; all secret values remain empty:

```dotenv
NODE_ENV=development
PORT=4000
DATABASE_URL=
TEST_DATABASE_URL=
DB_POOL_MAX=5
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000
CORS_ORIGINS=http://localhost:3000
JWT_ACCESS_SECRET=
JWT_ACCESS_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
OTP_HMAC_SECRET=
SMS_PROVIDER=
SMS_API_KEY=
TELEGRAM_CLIENT_ID=
TELEGRAM_CLIENT_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_REDIRECT_URI=
STORAGE_ROOT=
AI_PROVIDER=
AI_API_KEY=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=
```

Pool sizes and TTL values are starting proposals, not confirmed product requirements. Validate only settings needed for enabled features. An unimplemented AI feature must not prevent the basic server from starting, while an enabled provider without a required key should fail clearly.

app.js constructs the Express app, bounded parsers, CORS allowlist, routes and error handler. Importing it must not listen, run migrations, start cron jobs or modify database state.

server.js loads configuration, performs required readiness checks through a health service/repository, starts HTTP and handles SIGTERM/SIGINT. Stop accepting requests and close the server and pool within a defined grace period. Worker processes manage their own pool lifecycle. Do not log connection strings or secrets.

Expose process health and database readiness separately without revealing configuration. Readiness SQL belongs in health-repository.js, not directly in a route.

## 10. HTTP API, validation and errors

Preserve an existing frontend API contract if one is already established. Otherwise the proposed prefix is /api/v1, with camelCase JSON and snake_case SQL. Keep explicit boundary mapping rather than renaming database columns for convenience.

Proposed response shapes:

```json
{"data":{"id":"example-resource-id"}}
```

```json
{"error":{"code":"MODULE_ACCESS_REQUIRED","message":"Module access has not been granted","details":[]}}
```

These are proposals until actual CRM/frontend conventions are inspected. Require validated pagination for large lists. Do not send the entire question bank to a student.

Use consistent status codes: 400 input error, 401 no valid session, 403 forbidden action, 404 absent/hidden resource, 409 state conflict and 429 limit. Apply resource-hiding behavior consistently. Password reset responses must not disclose whether a phone exists.

Use one global error handler. Match async error forwarding to the installed Express version; do not add an extra compatibility package automatically. Map expected constraint conflicts to stable domain errors without leaking SQL, constraint internals, stack traces or raw provider secrets.

Validate internal IDs as canonical positive `BIGINT` decimal strings, E.164 phones, string lengths, allowed body properties, numeric ranges, enums, pagination and file contents/MIME. Never coerce database IDs through JavaScript `Number`. Follow the repository's existing validator; for a new project choose one small consistent approach instead of mixing several libraries.

Authentication middleware calls the relevant service. It must not issue its own session SQL. Providers and jobs likewise call services instead of bypassing the required persistence boundary.

## 11. Users and authentication

Tables: users, user_profiles, user_phones, user_passwords, auth_identities, roles, user_roles, auth_sessions, auth_refresh_tokens, auth_challenges, sms_deliveries, audit_events and user_invitations. Authentication persistence belongs in auth/users/audit repositories; orchestration belongs in auth-service.

One users.id combines sign-in identities and learning history. A Telegram-only intermediate account may lack a password or phone. Whether a verified phone is required before activation is unresolved. Telegram username is not the student's confirmed learning profile name.

M02B phone/password registration uses a normalized E.164 phone, a password hash, first/last name, a pending user, and the student role. It does not depend on SMS or OTP. Password login is allowed only after the separate approval milestone has made the account active. Do not accept elevated roles from registration input.

Verify Telegram using the selected official server-side protocol and stable provider subject, with issuer/audience/expiry and applicable state/nonce/PKCE checks. Linking requires an authenticated owner and fresh verification for the sensitive action. Never merge accounts by name, username or an unverified phone. Do not remove the last usable sign-in method.

Use short-lived access JWTs and opaque random refresh tokens stored as hashes. Retain refresh rotation history and revoke the session on reuse. Check user/session state after password reset or blocking even when an access JWT has not expired; jwt.verify alone is insufficient.

Choose cookie/Bearer transport according to real frontend/backend origins. Cookie authentication requires HttpOnly/Secure/SameSite and appropriate CSRF protection; CORS is not a CSRF substitute. Do not default refresh tokens to localStorage merely for convenience.

Reset flow: request a linked verified phone, issue a bounded one-time challenge, accept code plus new password, atomically consume the code, replace the hash, revoke sessions/other reset challenges and append audit. Protect a short OTP using HMAC with a server secret and challenge identity or an appropriate slow hash. Do not use plain SHA256 of a short code or a fixed production fallback OTP.

Rate-limit by phone/IP/global budget and apply resend cooldowns. No configured SMS provider means a clearly unavailable integration, not simulated production success. Test providers are allowed only in explicitly isolated test configuration.

Authentication is split into separate increments: M02B registration/password login; M02C approval/blocking; M02D refresh/logout/session management; M02E Telegram/SMS recovery and password reset; M02F RBAC and protection hardening. A later route is not implemented simply because this document lists it.

## 12. Groups, courses and individual access

Groups use groups, group_members, group_teachers, group_announcements and announcement_assets. There is no group_courses relation and group membership never grants course access. A group teacher does not automatically become a course teacher.

Courses contain course_modules and lessons; lesson_resources refer to assets. An authorized administrator individually grants course_enrollments and separate module_access_grants. A course grant does not open all modules.

Effective lesson access requires an active completed account, valid session, published resources, an effective course enrollment and an effective module grant. Check dates and revocation at protected reads, video/file issuance, course-scoped tests and offline lease creation. The frontend lock is not an access-control boundary.

Admin services authorize the actor, validate the student/module/course and chosen dates, and invoke repositories for reads, locks, writes and audit. Keep the full operation in one transaction when needed. Respect actual constraints: course enrollment is unique on user/course; module grant is unique on user/module; module/course ownership is protected by composite FK.

Do not silently create a missing course enrollment during an operation requested only to grant a module unless that behavior has explicitly been chosen. Reissuing an expired/revoked grant also needs an explicit policy rather than treating ON CONFLICT DO NOTHING as successful reactivation.

Locked published modules expose only safe title/order/count metadata and locked state. Do not return lesson text, answers, video URLs or restricted resources. The course Materials tab must honor the same module access. Absence of a grant is not evidence of recorded nonpayment; a payment module is not yet agreed.

Preserve learning history after access expires or is revoked. In the current model, restoring a course enrollment can make still-valid old module grants effective again; a full reset requires explicitly revoking them too. Document the selected administrative behavior.

## 13. Question bank and book imports

Use the existing subjects/sections/topics/translations and question_banks/questions/options/matching_items/answer_keys/topics/assets/duplicate_links/imports/errors tables. Check actual SQL names rather than creating alternative banks/options tables.

Correctness is authored only in question_answer_keys. Do not add is_correct to options. content.blocks preserves text, emphasis, verse lines, formulas, chemistry, tables and images. The Tajik language code is tg. Translations are optional.

Validate type-specific answer_data and ownership of referenced option/matching IDs before verification. AI-proposed answers are not verified keys. Unknown answers remain unknown and imported book questions remain draft. SQL publication triggers do not replace full input/JSON validation.

Published questions, keys, options and tests are immutable; changes use copies. grading_snapshot is private historical grading evidence, not a second editable answer source or a student response field.

When book import work begins, create its package-format documentation under the approved future `docs/imports/` location. That document does not currently exist. The future import service must validate manifest/schema/hashes/files/references, perform dry-run and produce reports. Repositories own staging, resolving external IDs, persistence and count queries. sourceNamespace/external asset IDs resolve through asset_aliases to internal numeric IDs. Preserve unknown matching rules and do not replace null with false.

Resolve questions by bank_id plus external_id. Validate references before insertion; do not silently lose rows through INNER JOIN. Avoid unconditional ON CONFLICT updates to published, used or manually corrected records. Report input/insert/update/skip/error totals. ZIP processing must reject traversal and decompression abuse; never execute embedded SQL/scripts.

Prior documentation reports 972 Tajik-book questions and zero verified keys. Do not call that independent PDF verification or publish the bank automatically.

## 14. Assessments, attempts and grading

Use tests -> test_questions -> questions. A test assignment targets exactly one audience kind: course, lesson, group or user. Several audiences require separate assignments. Group test access does not open courses or videos.

Use test_attempts -> attempt_questions -> student_answers. Fix question/option order when starting. Autosave updates one current answer using revision; preserve composite FKs binding attempts, assignments, tests and questions.

The attempt service checks assignment, timing, access, limits and publication, then calls repositories to lock/start/save/finalize. Serialize start by assignment/user, and validate state/expiry/revision under the relevant locks. Reject changes after submission. Server expiry checks are authoritative; a job is only assistance. Practice pause behavior and exam/NCT no-pause behavior must follow explicit policies.

The scope of the NCT one-attempt rule is unresolved. The reference numbers attempts per assignment/user; do not silently turn this into a global lifetime ban. Partial scoring, numeric tolerance, reveal timing and ranking remain explicit decisions.

Calculate group ranking from the selected common group assignments; do not combine private practice scores and spendable bonuses without a decision. Managed regrading records attempt_score_revisions and audit. Correct rewards using compensating journal entries, not duplicate awards.

## 15. AI, bonuses, notifications and workers

The AI provider/model is not finally selected. General/course chat may use only authorized data and accessible modules. Do not expose arbitrary SQL or administrative tools to the model.

Services choose the AI request workflow; repositories lock budgets/policies/credit grants, reserve resources, append usage and settle/release atomically. Perform paid API calls outside long-held database transactions. Reconcile unknown outcomes before refunding/retrying. Bonus AI packages do not bypass the center's cash budget.

Bonus and AI journals are append-only. Lock the relevant account/reservation before spending, enforce idempotency and persist redemption plus grant consistently. Do not hard-code unapproved bonus values, package prices, refunds or shared-versus-personal group limits.

Notifications use in-app, Push and Telegram. Telegram identity for sign-in differs from a bot connection permitted to receive messages. Validate that notification recipients own the targeted subscription/connection. External delivery is not exactly-once merely because a local UNIQUE exists.

When background processing is implemented, `jobs/index.js` will register processors and `jobs/worker.js` will start a worker explicitly. Neither file exists today. A future node-cron scheduler will not by itself ensure single execution across PM2 workers. Queue repositories own SKIP LOCKED/lease/retry SQL, while job handlers call application services. Do not start a scheduler as an app.js import side effect.

Stats/export services use their repositories and the same teacher/resource restrictions as ordinary API reads. An Excel export must not bypass access control.

## 16. Verification and acceptance checks

Preserve an existing test runner/linter. For a fresh project, node:test and an HTTP test client are reasonable options; adding repositories does not require a new TypeScript or test framework.

Verify the implemented increment meaningfully:

- migrations apply to a clean disposable PostgreSQL and reapply after safe rollback;
- routes/controllers/services contain no application SQL or direct pg queries;
- all repositories inside one atomic workflow receive the same client;
- transaction owner releases the client and entity repositories do not commit independently;
- rollback prevents partial grants/audit/bonus operations;
- duplicate phones/identities and concurrent registration do not duplicate accounts;
- pending/blocked users, revoked sessions and self-assigned roles are rejected;
- OTP expiry/attempt limits/single use and password-reset session revocation work;
- a module in another course cannot receive an inconsistent grant;
- course/module expiry and revocation close protected files while preserving progress;
- keys/snapshots remain private and published question/test edits are rejected;
- autosave after submit and duplicate concurrent finalization cannot mutate results twice;
- bonus/AI retry does not duplicate rewards or spending;
- logs/responses contain no secrets or unrelated private data.

Use a real disposable PostgreSQL-compatible database for FK/locking/transaction behavior, not only mocked query calls. Provider test doubles are appropriate for isolated tests but do not demonstrate live SMS/Telegram delivery.

Report actual commands and results, checks not run and reasons. Syntax checks are not end-to-end acceptance tests. Document-only work must not be described as a working backend.

## 17. Implementation stages

Implement small complete increments:

1. Documents, conventions, minimal Express/pg foundation, environment/error handling, health/readiness repositories and migration configuration.
2. M02A Telegram OIDC authentication and linking.
3. M02B phone/password registration and login, without SMS/OTP or approval endpoints.
4. M02C account approval and blocking.
5. M02D refresh/logout/session lifecycle.
6. M02E password recovery through Telegram and later SMS/OTP after provider selection.
7. M02F RBAC, resource authorization, rate limiting, brute-force protection, CSRF strategy and hardening.
8. Assets, courses, modules, lessons, individual grants and protected file issuance.
9. Groups, members, teachers and announcements.
10. Question bank, keys and safe dry-run import.
11. Test assignment, attempts, server timer, autosave, grading and results.
12. Worker/notifications, AI budget, bonuses/achievements, analytics/export and offline improvements.

For each feature, create its required route/controller/service/repository files together. Do not generate all 81 tables/endpoints at once.

Suggested initial instruction for either agent:

“Read AGENTS.md, CLAUDE.md where applicable, documentation.md, the reference SQL and any CRM examples. Establish conventions and install the portable project skill. Implement only the first requested foundation increment using JavaScript, Express, pg and node-pg-migrate, with mandatory repositories for every application query. Do not connect paid providers, reinitialize an existing backend or modify production. Verify the result and update docs/progress.md.”

If asked only to prepare documentation, stop at documentation. If asked to implement an increment, complete and verify that increment rather than stopping at a plan.

## 18. Shared Codex / Claude Code workflow

Use one repository and one rule set. Codex may start the backend; Claude Code must continue the same implementation rather than generate an alternative architecture.

Root AGENTS.md is the shared architectural source. Root CLAUDE.md imports it with:

```markdown
@AGENTS.md
```

Keep CLAUDE.md small. Do not maintain a second translated or conflicting copy of the architectural rules there. The import is supported by Claude Code and remains useful in sessions that do not read AGENTS.md directly. These instruction files guide an agent; they do not mechanically enforce the architecture, so code review/tests still matter.

For local project skill discovery, use:

- Codex: .agents/skills/everest-backend/SKILL.md;
- Claude Code: .claude/skills/everest-backend/SKILL.md.

The SKILL.md and references/project-rules.md contents must match in both locations. Use the portable files in section 21. For a Windows-friendly setup, create identical copies and verify equality; do not rely on symlinks requiring extra OS permissions. When changing the skill, update both copies in the same change. Tool-specific optional metadata may differ, but shared rules must not.

Before every handoff, update docs/progress.md with:

- current increment and implemented behavior;
- files changed and relevant migration names;
- actual setup/test commands and their results;
- unfinished code, failed checks and configuration blockers;
- open decisions, next concrete task and any uncommitted changes;
- relevant commit identifier, if available.

On resume, the next agent reads shared instructions, documentation, progress, actual git status/diff and migration history. It verifies the recorded state against code. Do not discard uncommitted changes, rerun destructive initialization, recreate existing tables, reinstall the whole project or pretend an old planned endpoint already exists.

Use docs/decisions.md for accepted decisions and docs/api.md for implemented contracts. Do not record API keys, tokens or private credentials in handoff notes. Do not assume ChatGPT Work skills or chat history automatically synchronize to the user's VS Code/Claude Code installation.

## 19. Open product decisions

Ask only what blocks the next increment; do not repeat already answered scope questions.

- Whether Telegram-only students must add a verified phone before activation;
- mandatory profile fields and exact owner/admin/teacher permissions;
- an SMS provider that delivers to +992, code TTL/cooldown/limits and phone-change recovery;
- token transport and frontend/backend domains;
- course/module expiry and reactivation policy;
- NCT attempt scope, answer reveal, partial credit and numeric normalization;
- group ranking formula and period;
- AI model/budget, shared or personal group norms and package/daily-limit interaction;
- lesson completion threshold and offline lease/conflict rules.

The mandatory repositories layer is now confirmed and is not an open question. group_courses, EduCRM and built-in video calls remain excluded.

## 20. Official references and skill installation

Checked on 24 October 2026:

- https://github.com/anthropics/skills
- https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
- https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md
- https://learn.chatgpt.com/docs/build-skills
- https://learn.chatgpt.com/docs/customization/overview
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/skills
- https://node-postgres.com/features/queries
- https://node-postgres.com/features/transactions
- https://salsita.github.io/node-pg-migrate/getting-started

The custom everest-backend skill is not an official Anthropic backend standard. Anthropic's skill-creator concerns authoring skills and webapp-testing concerns browser tests. The project-specific architecture comes from the user's decisions.

Both agents support the shared Agent Skills format, but their local discovery paths differ. Check the installed agent's documentation if the skill does not appear. Its name is everest-backend; invoke through the agent's supported skill selector/command. Instructions below are portable project files, not a claim that anything was installed on the user's computer.

## 21. Portable skill files

Create the following two files under BOTH .agents/skills/everest-backend/ and .claude/skills/everest-backend/. Preserve the relative references/project-rules.md link. Both copies must remain identical.

### SKILL.md

````markdown
---
name: everest-backend
description: Develop and review EVEREST backend in Shohrukh’s CRM style using JavaScript, Express, pg and node-pg-migrate. Use for EVEREST routes, controllers, services, mandatory repositories, SQL transactions, migrations, access control, authentication, question imports, tests, jobs and API documentation. Preserve the existing layer-based src structure; do not migrate to TypeScript, an ORM or feature folders without the user’s request.
---

# EVEREST Backend

## Establish context

Read repository AGENTS.md, CLAUDE.md when present, documentation.md, docs/progress.md when present, package.json, lockfile and relevant migrations. For project invariants and defaults, read [project-rules.md](references/project-rules.md). When working on external integrations or migration tooling, consult the installed version and current official documentation.

Inspect representative route, controller, service, repository, configs/db.js and one migration before changing code. If only a prose CRM description is available, distinguish observed structure from unknown syntax. Follow actual code for CommonJS/ESM, named exports, indentation, quotes, function/class style and response shape. For an empty repository, use the documented JavaScript/CommonJS fallback and record it as a new choice, not an inferred fact about CRM.

## Preserve structure

Keep src/app.js and src/server.js; configs/, routes/, controllers/, services/, repositories/, middleware/, migrations/, jobs/, prompts/, uploads/, utils/. Keep kebab-case filenames such as course-access-service.js and users-controller.js. Use snake_case SQL identifiers. Add only files needed for the current increment, not placeholder files for every future entity.

Keep business rules and transaction scope in services, HTTP handling in controllers and wiring in routes. Repositories are mandatory for all application SQL, including reads, writes and locks. Store them under src/repositories/ with domain subfolders when useful. Do not call pool.query/client.query or embed SQL in services, controllers, routes, middleware, providers or jobs. Keep connection construction in configs/db.js and schema SQL in migrations. Do not introduce a DI/DTO framework just to add repositories. Preserve existing function or class organization.

## Implement one increment

1. Read current requirements and schema for the affected module. Identify unresolved choices that change this increment; reuse explicit user decisions rather than asking again.
2. Define input validation, actor permission, resource scope, state transitions and expected response.
3. Write new node-pg-migrate JavaScript migrations for schema changes. Preserve applied migrations and existing data. Treat full SQL as a baseline/reference, not an incremental script to rerun.
4. Implement route → controller → service → repository → pg, with explicit safe response fields.
5. Have the service choose the atomic business operation. Implement withTransaction in repositories/transaction-repository.js: acquire one Pool client, run BEGIN, invoke the callback, COMMIT or ROLLBACK, and release in finally. Pass that same client to every participating repository. Entity repositories never start or commit their own transaction, acquire another client or release the caller’s client. Do not run transaction statements through pool.query.
6. Serialize competing mutations with row/advisory locks or constraints. Apply idempotency to attempts, grading, rewards, budget reserves and provider retries.
7. Run relevant validation and integration checks against a disposable test database. Report actual results and blockers accurately.
8. Update documentation.md, docs/api.md, docs/decisions.md and docs/progress.md with implemented behavior, tested commands/results and the next unfinished step. When switching Codex/Claude Code, inspect git status/diff and applied migrations before continuing; do not reinitialize or repeat applied changes.

## Enforce data and access rules

Use one users.id for phone/password/Telegram identity and learning history. Verify Telegram through its official protocol. Reset passwords only through an already linked verified phone or another separately authorized recovery flow. Keep raw passwords, OTPs, refresh tokens and provider keys out of logs and database metadata.

Treat active account, live session, role permission and resource grant as separate checks. Do not rely on an unexpired JWT alone after session revocation. Never trust a client-supplied user_id as the authenticated actor.

Keep groups independent from courses: no group_courses, no automatic access from membership. Only an authorized administrator grants course_enrollments and separate module_access_grants. Check both grants and their dates/revocation for lessons, files, course-scoped tests and offline permissions. Expose only safe metadata for locked modules.

Keep published question/test content immutable. Author correctness only in question_answer_keys; options have no is_correct. Keep all unreviewed book imports draft and unknown answers unknown. Treat grading_snapshot as private historical evidence, not a second editable key. Never serialize it in student responses.

Lock and validate attempts before autosave, submit, expiry and grading; reject edits after finalization. Use revision for concurrent autosave. Do not silently choose NCT attempt scope, partial credit, reveal timing or ranking formula when the user has not decided them.

Keep bonus and AI usage journals append-only. Reserve AI budget before a paid call; reconcile unknown outcomes before refund/retry. Exchange packages do not override the center’s cash budget.

## Check implementation details

Parameterize SQL values with $1/$2. Allowlist dynamic identifiers and ORDER BY fields; parameters cannot safely substitute identifiers. Do not send arbitrary SQL from an AI model to the database.

Validate IDs, bodies, pagination and file contents. Map database errors to stable API errors without SQL text, stack traces or private data. Preserve NUMERIC/BIGINT precision; do not blindly convert all numeric strings to Number.

Keep migrations out of per-request startup. Importing app.js must not listen, run jobs or mutate schema. Start workers explicitly, and use PostgreSQL leases/locks for multi-process safety. Do not assume a cron runs once under PM2 cluster.

Do not introduce Groq, SMS, video hosting, Redis or another paid provider solely because it existed in CRM. Add provider adapters only when required by the current task. Do not reintroduce EduCRM integration, videoconferencing, multitenancy or question_versions.

## Completion report

Keep root AGENTS.md as the shared rules for Codex and Claude Code. CLAUDE.md imports it. Install matching skill files in the documented discovery folders; synchronize both copies when copies are used.

State what changed, the relevant files, how it was verified, actual test results and unresolved decisions. Separate planned work from implemented behavior. Keep changes scoped to the user’s requested increment.

This is a custom EVEREST skill. It is not an official Anthropic backend skill. Its format follows the Agent Skills convention; the engineering rules come from the user’s CRM description and EVEREST decisions.

````

## 22. Implementation status — 24 October 2026

Milestone 1 uses native JavaScript ES Modules. The Express/pg foundation, repository-owned health/readiness checks, transaction helper, graceful HTTP lifecycle, environment configuration, and 12 raw-SQL node-pg-migrate baseline migrations are implemented. Milestone 2A adds Telegram OpenID Connect Authorization Code Flow with PKCE, one-use encrypted authorization state, verified identity linking, EVEREST sessions, bot connection testing, and one incremental raw-SQL migration. The baseline was not rerun. See `docs/progress.md`, `docs/decisions.md`, and `docs/api.md` for executed checks, the disposable-database permission blocker, security decisions, and endpoint contracts.

### references/project-rules.md

````markdown
# Project rules and evidence

## Contents

- Confirmed structure and unknown syntax
- EVEREST domain invariants
- Database and migration workflow
- Integration and test boundaries

## Confirmed structure and unknown syntax

The user supplied a prose description of CRM backend, not its source repository. It identifies JavaScript, Express, PostgreSQL, pg, node-pg-migrate, bcrypt, jsonwebtoken, multer, node-cron, web-push, exceljs and date-fns. CRM has layer-based configs/controllers/services/routes/middleware/migrations/jobs/prompts/uploads/utils, app.js and server.js. notifications and stats have specialized repositories. Preserve that organization for EVEREST with the user’s explicit 24 October 2026 change: a mandatory top-level src/repositories/ layer for application SQL.

The description does not establish CommonJS versus ESM, function versus class services, named export conventions, exact middleware signatures, indentation, quote style, error envelope or DB environment variable names. Inspect actual code when available. If initializing a new project without examples, use JavaScript/CommonJS, async/await, kebab-case filenames and business services calling SQL repositories as explicit provisional defaults. Do not call these defaults verified CRM style.

Keep error-handler.js in configs if preserving the supplied layout. Do not move folders just to match a preferred convention. Add .env.example with empty secret placeholders; do not copy production .env, database dumps or old deployment credentials.

## EVEREST domain invariants

- One center; roles owner/admin/teacher/student. Account active, session valid, authorized action and resource access must all hold.
- Telephone/password and Telegram bind to the same users.id. No account merging by name, username or unverified phone.
- groups, group_members, group_teachers, group_announcements and announcement_assets are needed. group_courses is explicitly excluded.
- courses → course_modules → lessons. An administrator individually grants course_enrollments and module_access_grants. Granting a course does not open all modules. Membership in a group grants neither.
- Locked modules expose only published safe metadata. Preserve progress after expiry/revocation.
- In the v0.2 reference, course_enrollments is unique on (user_id,course_id), module_access_grants on (user_id,module_id), and course_modules has UNIQUE(id,course_id). Grants also require id, granted_by and dates/optional revocation fields. Do not substitute a different ON CONFLICT target or omit required columns when writing executable inserts. Read the actual table definition; if only a minimal illustrative schema is supplied, keep pseudocode separate from migration-ready code.
- Questions use content.blocks, options, matching items and question_answer_keys. No question_versions and no options.is_correct. Published content changes through a copy.
- Prior documentation reports 972 Tajik-book questions with no verified keys; do not claim independent PDF verification or publish them automatically.
- A future book-indexing instruction and backend documentation are different documents. Use the planned `docs/imports/` location only when that work begins.
- Exclude EduCRM, integrated video calls and automatic payment integrations unless explicitly requested later.
- Groups’ ranking, NCT attempt scope, SMS vendor, Telegram-only mandatory phone, expiry defaults, partial scoring and AI package interactions remain configurable/open. An earlier proposal is not user confirmation.

## Database and migration workflow

Read root `schema_tables.md` and the applied migrations. The baseline describes 81 tables but is not by itself proof that an API/server is implemented. Write incremental JavaScript node-pg-migrate migrations in src/migrations. Use generated `BIGINT` entity keys, `BIGINT` references, TIMESTAMPTZ, NUMERIC/integer money units, parameterized queries, FK/UNIQUE/CHECK and appropriate indexes. UUID is reserved for reviewed opaque values such as idempotency keys.

For a new DB, apply only migrations needed by the current increment. For an existing DB, inspect applied migrations/catalog and reconcile changes; never run the full baseline on top of existing auth tables. Preserve composite FKs tying module/course/enrollment and test/assignment/question/attempt.

Use pgm.sql for functions/triggers or constraints where the chosen migration API is inconvenient. A DBML or schema-only diagram export may be generated later when requested; no such file currently exists. Do not delete DB protections to satisfy a diagram importer.

Test migration up, rollback where safe, and reapplication in disposable DBs. Do not pretend destructive down migrations preserve learning history. Run deploy migrations once with the migration tool’s locking mechanism, not from every PM2 worker.

## Integration and test boundaries

Importing app.js constructs the Express app only. server.js starts HTTP and graceful shutdown. jobs/index.js registers processors; an explicit worker entry starts them when needed. Scheduled work across processes needs locks/leases.

Use route → controller → service → repository → pg. Application queries, health checks, row/advisory locks and database writes belong in src/repositories/. Services decide transaction scope without query() or SQL strings. repositories/transaction-repository.js handles BEGIN/COMMIT/ROLLBACK and connection lifecycle. Entity repositories accept the same client; only the transaction helper releases it. Schema SQL in migrations is the explicit exception.

For new EVEREST code, place notification/statistics repositories under src/repositories/notifications/ and src/repositories/stats/. Do not maintain a second convention nested under services. Adapt existing code by requested increment, without unrelated wholesale moves.

Keep AGENTS.md as shared instructions. Root CLAUDE.md imports @AGENTS.md. Use documented per-agent skill discovery folders and synchronize any copies. Both agents read docs/progress.md, actual git status/diff and migrations before resuming; record tested commands, incomplete work and unresolved choices.

Useful tests exercise forbidden access, duplicate identities/phones, revocation, concurrent attempts/autosave, single-use OTP, grant mismatch, immutable published questions, idempotent ledger entries and exact accounting. Prefer existing tools; for a fresh project node:test and an HTTP test client are reasonable choices. External providers use test doubles until configured, and test mode must never become an auth bypass in production.

Official references checked 24 October 2026:

- https://node-postgres.com/features/queries
- https://node-postgres.com/features/transactions
- https://salsita.github.io/node-pg-migrate/getting-started
- https://github.com/anthropics/skills
- https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md
- https://raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md
- https://learn.chatgpt.com/docs/build-skills

Anthropic skill-creator is a skill authoring reference; webapp-testing concerns Playwright browser checks. Neither is a JavaScript/Express/pg architecture standard. Do not attribute this custom skill to Anthropic.

- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/skills

````

