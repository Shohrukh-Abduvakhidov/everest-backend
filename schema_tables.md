# EVEREST — Database Table Specification and Migration Contract

Version: 0.2.1 documentation, based on the v0.2 database baseline. Date: 2026-10-24.
Language: English. Audience: Codex, Claude Code and backend developers.
Authoritative repository location: root `schema_tables.md`.

Reading strategy for an agent: read sections 1–5 first, then the affected module in section 6. For complete migration authoring also read section 7 in full, including its late ALTERs, indexes and guards. Do not treat a partial table excerpt as the complete schema. Sections 8–10 define handoff requirements and the implementation prompt.

## 1. Scope, authority and agent instructions

This is a self-contained specification for the **existing designed schema**, not a claim that tables are deployed in a live database. It describes 81 application tables. It includes exact column definitions, constraints, foreign keys, indexes and the complete baseline SQL so an agent can create JavaScript migrations without reconstructing DDL from presentation slides.

Historical source inputs (not files currently present in this repository): `everest_full_v0_2.sql`, its PostgreSQL catalog metadata and `everest_architecture_v0_2.md`. The latest user instruction makes `src/repositories/` mandatory for all application SQL and transaction infrastructure. The presentation is explanatory; it does not override this schema.

Authority order:

1. Explicit later user decisions and recorded approved changes.
2. Applied migration history and actual database catalog for what already exists.
3. This document's baseline SQL for the intended v0.2 schema; its dictionary describes the same catalog.
4. Explanatory prose and diagrams.

If the actual database differs, write a reconciliation plan and incremental migrations. Never silently overwrite an existing schema, discard data or edit an already applied migration. If a later requirement changes the schema, record the decision and update this document alongside the new migration. Open product decisions below must not be presented as confirmed behavior.

### Required first action for the implementing agent

Read root `AGENTS.md`, `CLAUDE.md`, `documentation.md`, this file, `docs/decisions.md` and `docs/progress.md` when present; inspect `package.json`, the lockfile, representative code and `src/migrations/`. Inspect applied migrations and the target catalog before creating tables. Confirm the target is the intended development/test database. Do not infer successful deployment from this document.

Task boundary: implement the requested schema migrations and their validation. A schema request does not authorize fabricating endpoints, importing books, sending messages or calling paid AI providers. All 81 tables are the full target when the user requests the complete database; when implementing a feature increment, migrate only its dependency closure and record remaining modules.

## 2. Non-negotiable architecture and domain rules

- JavaScript, Node.js, Express, PostgreSQL, `pg` and `node-pg-migrate`. Preserve the existing layer-based `src/` structure and kebab-case filenames. No ORM, TypeScript rewrite or feature-folder reorganization without a request.
- Application flow: routes → controllers → services → repositories → pg. All application reads, writes, locks and health queries live in `src/repositories/`. DDL belongs in migrations. `configs/db.js` creates the pool.
- Services choose the atomic business operation. `repositories/transaction-repository.js` implements `withTransaction`: obtain one client, BEGIN, callback, COMMIT/ROLLBACK and release in finally. Participating repositories accept that same client; they never commit or release a caller-owned client. Do not use `pool.query` for a multi-statement transaction.
- One EVEREST center. No `tenant_id`, EduCRM integration, built-in video calls, `group_courses`, `question_versions`, payments or invoices in this target.
- Roles: owner/admin/teacher/student. A valid session, active account, role permission and effective resource grant are independent checks.
- One `users.id` ties phone, password, Telegram and all learning history together.
- Group membership grants neither courses nor modules. Group teachers do not automatically become course teachers.
- An authorized administrator grants a course and each allowed module separately. Course access alone does not open every module. Locked modules expose only safe published metadata; lesson content, protected files and test keys remain private.
- Correctness is authored only in `question_answer_keys`. There is no `question_options.is_correct`. Private attempt grading snapshots are historical evidence and must not be returned by student APIs.
- Preserve learning history after access expiry/revocation. Published questions/tests are immutable as protected by the baseline guards; corrections use copies.
- UUIDs for application rows are supplied by backend code. There are no UUID extension/default requirements in this baseline. Four role UUIDs are fixed only for seed data.
- Use TIMESTAMPTZ; defaults do not automatically maintain `updated_at`. Backend updates it explicitly. Profile timezone defaults to `Asia/Dushanbe`; validate IANA names. Tajik language code is `tg`; supported UI codes are `tg`, `ru`, `en`.
- Keep NUMERIC and BIGINT precision. AI money uses integer millionths of the stored currency. Do not blindly parse all pg numeric strings as JavaScript Number.
- Binary files live outside PostgreSQL. Store durable storage keys, never Base64 videos or temporary signed URLs as persistent file identities.
- Parameterize SQL values and allowlist dynamic identifiers/sort fields. No model-generated SQL execution against production.

## 3. Migration implementation contract

### New empty database

Create ordered **JavaScript node-pg-migrate migrations** under `src/migrations/`. Follow the installed package's module conventions; inspect the repository before choosing CommonJS or ESM. For an empty project, CommonJS is an explicit fallback. Use the installed package version and lockfile; do not invent version numbers.

The complete SQL appendix is the exact baseline reference. It is not an additional migration to run after separately creating the same tables. Preserve all columns, defaults, nullability, CHECK/UNIQUE/PK/FK constraints, composite FK column order, delete behavior, indexes, functions, triggers and role seeds. `pgm.sql` can express definitions unsupported or awkward in the migration builder. Do not drop guards to make migrations easier.

Recommended split, preserving statement dependencies:

| Sequence | Migration scope | Important ordering |
|---|---|---|
| 01 | Core authentication | users, profiles, phones, passwords, identities, roles, user_roles, sessions, refresh tokens, challenges, SMS deliveries, audit, invitations |
| 02 | Assets | assets, aliases, then add user_profiles.avatar_asset_id and its FK |
| 03 | Groups | groups → members/teachers/announcements → announcement_assets |
| 04 | Taxonomy | subjects/translations → sections/translations → topics/translations |
| 05 | Learning | courses → course_teachers/enrollments/modules → module grants → lessons/resources/progress/notes/favorites/offline |
| 06 | Question bank | banks → imports/errors → questions → options/matching/keys/topics/assets/duplicates |
| 07 | Testing | tests → composition → assignments → attempts → attempt_questions → answers → score revisions |
| 08 | AI core | conversations/messages, policies, budgets, daily usage, requests/reservations/ledger/analyses; defer credit_grant_id until credits exist |
| 09 | Bonuses and credits | accounts/rules/transactions/offers/redemptions → ai_credit_grants → ai_requests.credit_grant_id and composite owner FK; achievements/awards |
| 10 | Messaging | Telegram/push/preferences → campaigns → notifications → deliveries |
| 11 | Operations | activity, jobs, idempotency, settings; add audit entity columns if not included in migration 01 |
| 12 | Cross-cutting protections and indexes | exact baseline functions, triggers, named indexes and four role seed rows; may be placed earlier once dependencies exist |

This is a split recommendation, not a second competing DDL. The appendix's exact statement order is also valid for a single initial baseline migration on a confirmed empty database. If splitting, use the exact blocks and move dependent ALTERs/protections deliberately. Ensure no table or index is duplicated across files. Do not parse SQL using naive semicolon splitting: function bodies contain semicolons. Keep function definitions as intact strings. When embedding SQL in JavaScript template literals, preserve SQL backslashes and literal dollar delimiters; use a verified representation such as String.raw or a properly escaped string. Check the SQL emitted by the migration.

Circular/later references to preserve:

- `assets.uploaded_by → users`; `user_profiles.avatar_asset_id → assets` is added after assets exist.
- `ai_requests.credit_grant_id` is added only after `ai_credit_grants`; its composite FK includes user_id.
- `audit_events.entity_type` and `entity_id` are added later in the baseline. The final dictionary already includes them. Do not create them twice.

### Existing database, including auth v0.1

Inspect actual definitions and migration history. Do not rerun the appendix or hide mismatches with blanket IF NOT EXISTS. Map existing objects to the v0.2 target and create explicit ALTER/CREATE migrations for the differences. Adding an FK/CHECK to populated tables requires data validation and a correction/backfill plan. Do not mark migrations as applied without proving equivalence. Preserve user IDs and role assignments.

### Transaction, rollback and deployment rules

Use normal transactional migration execution for this DDL. Do not call `pgm.noTransaction()` merely for convenience. Run deployment migrations once with the migration runner's locking behavior, not from every PM2 process or request. `app.js` imports must not migrate the schema, start listeners or launch workers.

Implement truthful down behavior: reverse dependencies and remove dependent triggers/functions/FKs before their owners. Initial table drops are destructive and are for disposable test databases only. If production reversal cannot preserve data, document a forward-fix procedure and make unsupported rollback fail explicitly. Do not use CASCADE as a substitute for understanding dependencies. Do not infer that automatically generated down SQL correctly restores all custom pgm.sql objects.

### Required verification and handoff

1. Apply up to a disposable PostgreSQL database matching the chosen server major version. PGlite is an additional development check, not a substitute for the server migration test.
2. Compare the final application catalog with this document: 81 tables, 641 columns and 156 FKs for the unchanged complete baseline; migration runner bookkeeping is additional. Verify PK/UNIQUE/CHECK, defaults, all indexes, functions and triggers, not just counts. This catalog reference contains 290 indexes, including PK/UNIQUE-backed indexes.
3. Test a safe disposable down/up cycle where implemented. For deliberately irreversible migrations, report that fact and test forward application instead.
4. Exercise negative cases: wrong-course module grant, invalid assignment audience, two live attempts, answer from a different attempt question, publication without verified key, immutable published content, duplicate reward event and append-only journal mutation.
5. Verify session revocation and grant expiry in backend integration tests when endpoints exist. No DDL-only test proves HTTP authorization, SMS delivery, AI accounting under competition or offline behavior.
6. Report actual commands, results, target engine/version and limitations. Update docs/progress.md with completed migration names and next work; inspect git status and applied migrations when Codex/Claude resumes.

## 4. Relationships and application-enforced behavior

### Authentication and recovery

`users` has one optional profile and password record, multiple verified phone/identity records, roles and sessions. `auth_sessions` owns refresh-token history. Challenges bind password resets to an already linked verified phone; the service must check the phone row still belongs to the account and matches the challenge target. SMS proves phone ownership, while administrative approval grants learning eligibility.

Finalize reset atomically: lock challenge, check purpose/owner/expiry/attempt count and unconsumed state, verify OTP, consume it, replace password hash and revoke sessions. Do not store raw OTPs, refresh tokens, passwords or provider secrets. Short OTP protection needs server-secret HMAC or suitable strong hashing, not plain unsalted SHA256. Enforce rate limits outside these basic constraints. Telegram identities must come from verified official authentication data. Bot connection permission is separate from login.

### Learning and groups

`courses → course_modules → lessons`; `users → course_enrollments` and `users → module_access_grants` provide separate grants. Composite relationships require that the grant's module belongs to its course and that the same user has that course enrollment. Evaluate active account/onboarding, published course/module/lesson, grant start/expiry/revocation and valid session. `can_access_module` covers only its SQL predicate; the API still owns session and actor validation.

Revoking a course closes its modules without deleting module grants or progress. Reopening it reactivates still-valid module grants unless explicitly revoked too. An administrator action that resets module grants must do so with audit in one transaction. Membership and teacher changes in groups are separate from these grants. Files and course-scoped AI/tests must enforce the same content boundaries.

Offline grants require an owned session, a permitted asset attached to the lesson, allow_offline, and an expiry bounded by access. Offline storage is not DRM and cannot guarantee immediate revocation while disconnected. Conflict resolution for progress revisions remains to be chosen. Personal notes are owner-only.

### Question bank and imports

Subjects contain sections and topics; question_topics links questions to topics within the same subject. Prevent long topic cycles with a transactional application check. Questions belong to one bank and optional import/source question. Options, matching items and answer keys belong to a question. Preserve unknown key status; AI proposals do not become verified automatically. Matching settings require explicit requireAllLeft/allowRightReuse booleans before publication.

Validate a package before writing it, default to dry-run, enforce bank/idempotency and bank/external_id uniqueness, report counts/errors and avoid overwriting published or manually reviewed questions. External file IDs resolve through asset_aliases. Do not execute SQL/HTML from an import. The earlier book package was documented as 972 draft questions and zero verified keys; this document does not independently verify OCR or import that package.

### Tests, attempts and ranking

Test composition is stored in test_questions. Each assignment targets exactly one of course/lesson/group/user; multiple audiences need separate assignments. A group test never grants course content. Course/lesson targeting additionally checks effective learning access.

Attempts reference both test and assignment. attempt_questions freezes composition/order and private grading evidence; student_answers stores one current answer with a revision. Composite FKs prevent cross-test/cross-question mixing. Lock attempts for autosave, submit, expiry and grading. Reject writes to finalized/expired attempts even if a background expiry job has not run. Serialize starting attempts per assignment/user. Practice pause and exam/NCT no-pause behavior must use an explicitly validated policy snapshot and server time.

Use NUMERIC scores and validate awarded_points against maxima in the service. Regrades create append-only score revisions; reward corrections are compensating transactions. Group ranking is computed from eligible group assignments; no editable ranking-position table exists. Formula, period and tie behavior are open. Do not assume assignment/user attempt counting is the final NCT rule.

### AI, budget and bonuses

AI chats are private. Course chats can use only accessible course modules; mistake analysis verifies attempt ownership. ai_limit_policies scopes and ai_daily_usage policy-local dates do not independently define product entitlement. Current global/group/course policies model shared pools provisionally; per-user quotas within a group would need an explicit schema change or materialized personal policies.

Before any paid call, lock the budget, applicable usage rows and optional credit grant in a consistent order; reserve upper-bound costs/usage and create ai_requests/reservations/ledger entries atomically. Validate provider/currency consistency and prevent overlapping active budgets from bypassing a limit. Settle actual cost after the response. Unknown external outcomes retain reservation until reconciliation; blind retry/refund can double-spend. The budget intentionally permits recording actual overspend; new reservations must then stop. Credit packages never override the center's cash budget.

Bonus balance is SUM(bonus_transactions.delta). Lock the account and check its balance before a debit; a CHECK over individual rows cannot enforce aggregate nonnegative balance. Exchange debit, redemption and AI grant are one idempotent transaction. Verify that linked debit/account/user/sign/amount match the exchange. Ledger corrections append compensating rows rather than rewriting facts.

### Notifications, workers and references without FKs

Campaign audiences are validated data, not SQL. Materialize notifications per recipient with deduplication; each delivery targets an endpoint owned by that recipient. Telegram login is not consent to bot messages. Provider idempotency and unknown-result reconciliation are needed beyond database UNIQUE constraints.

Workers claim background_jobs with database locks/leases; a process-local mutex does not coordinate PM2 processes. idempotency_keys must reject the same key with a different request hash. Generic audit entity IDs, JSON identifiers, queue payloads and campaign filters are application references, not guaranteed foreign keys. Validate them explicitly. Store no secrets in JSON metadata, logs or saved response bodies.

## 5. JSON contracts and unresolved product decisions

The exact JSONB object/array/null checks are listed per table and in the SQL. Flexible JSON does not mean arbitrary trusted input. Version and validate payloads in the backend before persistence. Content uses `{ "blocks": [...] }` with supported text/math/chemistry/image/table blocks; sanitize rendering and use asset IDs. Course/module/lesson optional translations are `ru/tg/en` dictionaries. Taxonomy translations are normalized rows.

Proposed typed answer-key contracts, to validate before setting verified:

| Question type | answer_data contract |
|---|---|
| single_choice | option_ids array containing exactly one existing option UUID from this question |
| multiple_choice | nonempty distinct option_ids from this question |
| matching | pairs of left_id/right_id belonging to this question; obey interaction_settings |
| numeric | accepted_values as decimal strings, explicit absolute_tolerance and optional unit |
| short_text | accepted_answers plus explicit normalization rules such as trim/case_fold |

Student answer_data is a separately validated learner payload; do not copy a verified key into a student response. policy_snapshot and grading_snapshot capture the rules used for that attempt and are not editable authoring sources. Decimal values must preserve exactness.

Open decisions: mandatory phone for Telegram-only activation; required surname/approval permissions; SMS provider/OTP TTL and resend limits; grant lifetime and reopening UX; NCT attempt scope and reveal timing; partial credit/numeric tolerance; ranking formula; shared vs personal AI quotas; bonus package interaction/expiry/refunds; offline lease/progress conflict/completion thresholds. Defaults in SQL are technical baseline choices, not evidence these product questions were approved. Resolve an affected decision before implementing its behavior, without blocking unrelated schema work.

## 6. Table dictionary

Each table lists every column, PK/UNIQUE/CHECK/FK definition and every index in the baseline catalog. `Required = yes` means NOT NULL, including PK columns. A dash under Default means no database default, not a default of NULL. JSON expressions and constraint casts are PostgreSQL catalog renderings of the source DDL. NOT NULL constraints are represented in the column table, not repeated as named entries. FK target uniqueness defines one-vs-many relationships: a unique FK (including a PK FK) limits the child to one row for that key; otherwise the parent can have many children. Composite FK columns must be kept together in their specified order.

Incoming references list actual FKs only. Polymorphic entity IDs and UUIDs nested in JSON do not acquire referential protection automatically.


### A. Authentication — 13 tables


#### `users`

Account lifecycle, approval, blocking and onboarding. All authentication methods and learning records share this account ID.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `status` | `varchar(16)` | yes | `'pending'::character varying` |
| `onboarding_completed_at` | `timestamptz` | no | — |
| `approved_by` | `uuid` | no | — |
| `approved_at` | `timestamptz` | no | — |
| `blocked_by` | `uuid` | no | — |
| `blocked_at` | `timestamptz` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `last_login_at` | `timestamptz` | no | — |

**Keys and constraints**

- `users_approval_actor_check`: `CHECK (((approved_by IS NULL) OR (approved_at IS NOT NULL)))`
- `users_approved_by_fkey`: `FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE RESTRICT`
- `users_blocked_by_fkey`: `FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE RESTRICT`
- `users_blocked_check`: `CHECK ((((status)::text <> 'blocked'::text) OR (blocked_at IS NOT NULL)))`
- `users_pkey`: `PRIMARY KEY (id)`
- `users_status_check`: `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'blocked'::character varying, 'rejected'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX users_approved_by_idx ON public.users USING btree (approved_by)`
- `CREATE INDEX users_blocked_by_idx ON public.users USING btree (blocked_by)`
- `CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)`
- `CREATE INDEX users_status_created_idx ON public.users USING btree (status, created_at)`

**Referenced by**

- `ai_analyses(user_id)` → `users(id)`
- `ai_conversations(user_id)` → `users(id)`
- `ai_credit_grants(user_id)` → `users(id)`
- `ai_limit_policies(created_by)` → `users(id)`
- `ai_limit_policies(user_id)` → `users(id)`
- `ai_requests(user_id)` → `users(id)`
- `assets(uploaded_by)` → `users(id)`
- `attempt_score_revisions(revised_by)` → `users(id)`
- `audit_events(actor_user_id)` → `users(id)`
- `audit_events(subject_user_id)` → `users(id)`
- `auth_challenges(user_id)` → `users(id)`
- `auth_identities(user_id)` → `users(id)`
- `auth_sessions(user_id)` → `users(id)`
- `bonus_accounts(user_id)` → `users(id)`
- `bonus_offers(created_by)` → `users(id)`
- `bonus_redemptions(user_id)` → `users(id)`
- `bonus_rules(created_by)` → `users(id)`
- `bonus_transactions(performed_by)` → `users(id)`
- `broadcast_campaigns(created_by)` → `users(id)`
- `course_enrollments(granted_by)` → `users(id)`
- `course_enrollments(revoked_by)` → `users(id)`
- `course_enrollments(user_id)` → `users(id)`
- `course_favorites(user_id)` → `users(id)`
- `course_teachers(assigned_by)` → `users(id)`
- `course_teachers(user_id)` → `users(id)`
- `courses(created_by)` → `users(id)`
- `group_announcements(author_id)` → `users(id)`
- `group_members(added_by)` → `users(id)`
- `group_members(user_id)` → `users(id)`
- `group_teachers(assigned_by)` → `users(id)`
- `group_teachers(user_id)` → `users(id)`
- `groups(created_by)` → `users(id)`
- `idempotency_keys(user_id)` → `users(id)`
- `learning_activity_events(user_id)` → `users(id)`
- `lesson_notes(user_id)` → `users(id)`
- `lesson_progress(user_id)` → `users(id)`
- `lessons(created_by)` → `users(id)`
- `module_access_grants(granted_by)` → `users(id)`
- `module_access_grants(revoked_by)` → `users(id)`
- `notification_preferences(user_id)` → `users(id)`
- `notifications(user_id)` → `users(id)`
- `offline_downloads(user_id)` → `users(id)`
- `platform_settings(updated_by)` → `users(id)`
- `push_subscriptions(user_id)` → `users(id)`
- `question_answer_keys(verified_by)` → `users(id)`
- `question_banks(owner_id)` → `users(id)`
- `question_duplicate_links(marked_by)` → `users(id)`
- `question_imports(initiated_by)` → `users(id)`
- `questions(created_by)` → `users(id)`
- `student_answers(graded_by)` → `users(id)`
- `telegram_connections(user_id)` → `users(id)`
- `test_assignments(assigned_by)` → `users(id)`
- `test_assignments(user_id)` → `users(id)`
- `test_attempts(user_id)` → `users(id)`
- `tests(created_by)` → `users(id)`
- `user_achievements(user_id)` → `users(id)`
- `user_invitations(accepted_by)` → `users(id)`
- `user_invitations(invited_by)` → `users(id)`
- `user_passwords(user_id)` → `users(id)`
- `user_phones(user_id)` → `users(id)`
- `user_profiles(user_id)` → `users(id)`
- `user_roles(assigned_by)` → `users(id)`
- `user_roles(user_id)` → `users(id)`
- `users(approved_by)` → `users(id)`
- `users(blocked_by)` → `users(id)`

#### `user_profiles`

One optional profile per account: names, preferred language, timezone and avatar.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `user_id` | `uuid` | yes | — |
| `first_name` | `varchar(100)` | no | — |
| `last_name` | `varchar(100)` | no | — |
| `language_code` | `varchar(2)` | yes | `'ru'::character varying` |
| `timezone` | `varchar(64)` | yes | `'Asia/Dushanbe'::character varying` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `avatar_asset_id` | `uuid` | no | — |

**Keys and constraints**

- `profiles_first_name_check`: `CHECK (((first_name IS NULL) OR (length(TRIM(BOTH FROM first_name)) > 0)))`
- `profiles_language_check`: `CHECK (((language_code)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `profiles_last_name_check`: `CHECK (((last_name IS NULL) OR (length(TRIM(BOTH FROM last_name)) > 0)))`
- `user_profiles_avatar_asset_id_fkey`: `FOREIGN KEY (avatar_asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `user_profiles_pkey`: `PRIMARY KEY (user_id)`
- `user_profiles_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_user_profiles_101_idx ON public.user_profiles USING btree (avatar_asset_id)`
- `CREATE UNIQUE INDEX user_profiles_pkey ON public.user_profiles USING btree (user_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `user_phones`

Normalized E.164 phone numbers, ownership verification and the primary verified number.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `phone_e164` | `varchar(16)` | yes | — |
| `is_primary` | `boolean` | yes | `false` |
| `verified_at` | `timestamptz` | no | — |
| `verification_method` | `varchar(24)` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `phones_e164_check`: `CHECK (((phone_e164)::text ~ '^\+[1-9][0-9]{1,14}$'::text))`
- `phones_id_user_unique`: `UNIQUE (id, user_id)`
- `phones_primary_verified_check`: `CHECK (((NOT is_primary) OR (verified_at IS NOT NULL)))`
- `phones_verification_check`: `CHECK ((((verified_at IS NULL) AND (verification_method IS NULL)) OR ((verified_at IS NOT NULL) AND (verification_method IS NOT NULL) AND ((verification_method)::text = ANY ((ARRAY['sms'::character varying, 'telegram_verified'::character varying, 'admin_verified'::character varying])::text[])))))`
- `user_phones_phone_e164_key`: `UNIQUE (phone_e164)`
- `user_phones_pkey`: `PRIMARY KEY (id)`
- `user_phones_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX phones_id_user_unique ON public.user_phones USING btree (id, user_id)`
- `CREATE UNIQUE INDEX user_phones_one_primary_idx ON public.user_phones USING btree (user_id) WHERE is_primary`
- `CREATE UNIQUE INDEX user_phones_phone_e164_key ON public.user_phones USING btree (phone_e164)`
- `CREATE UNIQUE INDEX user_phones_pkey ON public.user_phones USING btree (id)`
- `CREATE INDEX user_phones_user_idx ON public.user_phones USING btree (user_id)`

**Referenced by**

- `auth_challenges(user_phone_id, user_id)` → `user_phones(id, user_id)`

#### `user_passwords`

One password hash per account. Telegram-only accounts have no row until they set a password.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `user_id` | `uuid` | yes | — |
| `password_hash` | `text` | yes | — |
| `changed_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `passwords_hash_check`: `CHECK ((length(password_hash) > 0))`
- `user_passwords_pkey`: `PRIMARY KEY (user_id)`
- `user_passwords_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX user_passwords_pkey ON public.user_passwords USING btree (user_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `auth_identities`

Verified Telegram login identities keyed by provider, issuer and subject; never merge accounts by username.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `provider` | `varchar(24)` | yes | — |
| `issuer` | `text` | yes | — |
| `provider_subject` | `text` | yes | — |
| `provider_profile` | `jsonb` | yes | `'{}'::jsonb` |
| `linked_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `last_used_at` | `timestamptz` | no | — |

**Keys and constraints**

- `auth_identities_pkey`: `PRIMARY KEY (id)`
- `auth_identities_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `identities_nonempty_check`: `CHECK (((length(issuer) > 0) AND (length(provider_subject) > 0)))`
- `identities_profile_check`: `CHECK ((jsonb_typeof(provider_profile) = 'object'::text))`
- `identities_provider_check`: `CHECK (((provider)::text = 'telegram'::text))`
- `identities_subject_unique`: `UNIQUE (provider, issuer, provider_subject)`
- `identities_user_provider_unique`: `UNIQUE (user_id, provider, issuer)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX auth_identities_pkey ON public.auth_identities USING btree (id)`
- `CREATE UNIQUE INDEX identities_subject_unique ON public.auth_identities USING btree (provider, issuer, provider_subject)`
- `CREATE UNIQUE INDEX identities_user_provider_unique ON public.auth_identities USING btree (user_id, provider, issuer)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `roles`

The four supported role codes: owner, admin, teacher and student.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `varchar(24)` | yes | — |

**Keys and constraints**

- `roles_code_check`: `CHECK (((code)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'teacher'::character varying, 'student'::character varying])::text[])))`
- `roles_code_key`: `UNIQUE (code)`
- `roles_pkey`: `PRIMARY KEY (id)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX roles_code_key ON public.roles USING btree (code)`
- `CREATE UNIQUE INDEX roles_pkey ON public.roles USING btree (id)`

**Referenced by**

- `user_roles(role_id)` → `roles(id)`

#### `user_roles`

Many-to-many account roles, including assignment actor and time.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `user_id` | `uuid` | yes | — |
| `role_id` | `uuid` | yes | — |
| `assigned_by` | `uuid` | no | — |
| `assigned_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `user_roles_assigned_by_fkey`: `FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT`
- `user_roles_pkey`: `PRIMARY KEY (user_id, role_id)`
- `user_roles_role_id_fkey`: `FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT`
- `user_roles_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX user_roles_assigned_by_idx ON public.user_roles USING btree (assigned_by)`
- `CREATE UNIQUE INDEX user_roles_pkey ON public.user_roles USING btree (user_id, role_id)`
- `CREATE INDEX user_roles_role_idx ON public.user_roles USING btree (role_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `auth_sessions`

Device sessions, expiry and revocation. Check on every protected request.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | yes | — |
| `last_used_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | no | — |
| `revoke_reason` | `varchar(40)` | no | — |
| `user_agent` | `text` | no | — |
| `ip_address` | `inet` | no | — |

**Keys and constraints**

- `auth_sessions_pkey`: `PRIMARY KEY (id)`
- `auth_sessions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `sessions_expiry_check`: `CHECK ((expires_at > created_at))`
- `sessions_revoke_check`: `CHECK (((revoke_reason IS NULL) OR (revoked_at IS NOT NULL)))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX auth_sessions_pkey ON public.auth_sessions USING btree (id)`
- `CREATE INDEX sessions_expiry_idx ON public.auth_sessions USING btree (expires_at)`
- `CREATE INDEX sessions_user_idx ON public.auth_sessions USING btree (user_id)`

**Referenced by**

- `auth_refresh_tokens(session_id)` → `auth_sessions(id)`
- `offline_downloads(session_id)` → `auth_sessions(id)`

#### `auth_refresh_tokens`

Hashed refresh tokens and rotation history for replay detection; retain used tokens until safe cleanup.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `session_id` | `uuid` | yes | — |
| `token_hash` | `text` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | yes | — |
| `used_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | no | — |

**Keys and constraints**

- `auth_refresh_tokens_pkey`: `PRIMARY KEY (id)`
- `auth_refresh_tokens_session_id_fkey`: `FOREIGN KEY (session_id) REFERENCES auth_sessions(id) ON DELETE RESTRICT`
- `auth_refresh_tokens_token_hash_key`: `UNIQUE (token_hash)`
- `refresh_expiry_check`: `CHECK ((expires_at > created_at))`
- `refresh_hash_check`: `CHECK ((length(token_hash) > 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX auth_refresh_tokens_pkey ON public.auth_refresh_tokens USING btree (id)`
- `CREATE UNIQUE INDEX auth_refresh_tokens_token_hash_key ON public.auth_refresh_tokens USING btree (token_hash)`
- `CREATE INDEX refresh_session_idx ON public.auth_refresh_tokens USING btree (session_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `auth_challenges`

Single-use SMS challenges for registration, phone verification/change and password reset.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | no | — |
| `user_phone_id` | `uuid` | no | — |
| `purpose` | `varchar(32)` | yes | — |
| `channel` | `varchar(16)` | yes | `'sms'::character varying` |
| `target_phone_e164` | `varchar(16)` | yes | — |
| `secret_hash` | `text` | yes | — |
| `attempts_count` | `smallint` | yes | `0` |
| `max_attempts` | `smallint` | yes | `5` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | yes | — |
| `consumed_at` | `timestamptz` | no | — |
| `invalidated_at` | `timestamptz` | no | — |

**Keys and constraints**

- `auth_challenges_pkey`: `PRIMARY KEY (id)`
- `auth_challenges_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `challenges_attempts_check`: `CHECK (((max_attempts > 0) AND ((attempts_count >= 0) AND (attempts_count <= max_attempts))))`
- `challenges_channel_check`: `CHECK (((channel)::text = 'sms'::text))`
- `challenges_expiry_check`: `CHECK ((expires_at > created_at))`
- `challenges_owner_check`: `CHECK (((user_phone_id IS NULL) OR (user_id IS NOT NULL)))`
- `challenges_phone_check`: `CHECK (((target_phone_e164)::text ~ '^\+[1-9][0-9]{1,14}$'::text))`
- `challenges_phone_owner_fk`: `FOREIGN KEY (user_phone_id, user_id) REFERENCES user_phones(id, user_id) ON DELETE RESTRICT`
- `challenges_purpose_check`: `CHECK (((purpose)::text = ANY ((ARRAY['register_phone'::character varying, 'verify_phone'::character varying, 'reset_password'::character varying, 'change_phone'::character varying])::text[])))`
- `challenges_reset_binding_check`: `CHECK ((((purpose)::text <> 'reset_password'::text) OR ((user_id IS NOT NULL) AND (user_phone_id IS NOT NULL))))`
- `challenges_secret_check`: `CHECK ((length(secret_hash) > 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX auth_challenges_pkey ON public.auth_challenges USING btree (id)`
- `CREATE INDEX challenges_expiry_idx ON public.auth_challenges USING btree (expires_at)`
- `CREATE INDEX challenges_phone_owner_idx ON public.auth_challenges USING btree (user_phone_id, user_id)`
- `CREATE INDEX challenges_target_created_idx ON public.auth_challenges USING btree (target_phone_e164, purpose, created_at)`
- `CREATE INDEX challenges_user_idx ON public.auth_challenges USING btree (user_id)`

**Referenced by**

- `sms_deliveries(challenge_id)` → `auth_challenges(id)`

#### `sms_deliveries`

Provider-specific challenge delivery status, identifiers and retry deduplication.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `challenge_id` | `uuid` | yes | — |
| `provider_code` | `varchar(40)` | yes | — |
| `provider_message_id` | `text` | no | — |
| `idempotency_key` | `uuid` | yes | — |
| `status` | `varchar(16)` | yes | `'pending'::character varying` |
| `error_code` | `varchar(80)` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `sent_at` | `timestamptz` | no | — |
| `delivered_at` | `timestamptz` | no | — |

**Keys and constraints**

- `sms_deliveries_challenge_id_fkey`: `FOREIGN KEY (challenge_id) REFERENCES auth_challenges(id) ON DELETE RESTRICT`
- `sms_deliveries_idempotency_key_key`: `UNIQUE (idempotency_key)`
- `sms_deliveries_pkey`: `PRIMARY KEY (id)`
- `sms_provider_message_unique`: `UNIQUE (provider_code, provider_message_id)`
- `sms_status_check`: `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'delivered'::character varying, 'failed'::character varying, 'unknown'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX sms_challenge_idx ON public.sms_deliveries USING btree (challenge_id)`
- `CREATE UNIQUE INDEX sms_deliveries_idempotency_key_key ON public.sms_deliveries USING btree (idempotency_key)`
- `CREATE UNIQUE INDEX sms_deliveries_pkey ON public.sms_deliveries USING btree (id)`
- `CREATE UNIQUE INDEX sms_provider_message_unique ON public.sms_deliveries USING btree (provider_code, provider_message_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `audit_events`

Administrative and security audit records; generic entity_type/entity_id references are application-validated.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `actor_user_id` | `uuid` | no | — |
| `subject_user_id` | `uuid` | no | — |
| `event_code` | `varchar(80)` | yes | — |
| `metadata` | `jsonb` | yes | `'{}'::jsonb` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `entity_type` | `text` | no | — |
| `entity_id` | `uuid` | no | — |

**Keys and constraints**

- `audit_events_actor_user_id_fkey`: `FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `audit_events_pkey`: `PRIMARY KEY (id)`
- `audit_events_subject_user_id_fkey`: `FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `audit_metadata_check`: `CHECK ((jsonb_typeof(metadata) = 'object'::text))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX audit_actor_idx ON public.audit_events USING btree (actor_user_id, created_at)`
- `CREATE UNIQUE INDEX audit_events_pkey ON public.audit_events USING btree (id)`
- `CREATE INDEX audit_subject_idx ON public.audit_events USING btree (subject_user_id, created_at)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `user_invitations`

Hashed invitation tokens with expiry and consumption tracking; no public privilege escalation.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `invited_phone_e164` | `varchar(16)` | no | — |
| `token_hash` | `text` | yes | — |
| `invited_by` | `uuid` | yes | — |
| `accepted_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | yes | — |
| `accepted_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | no | — |

**Keys and constraints**

- `user_invitations_accepted_by_fkey`: `FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE RESTRICT`
- `user_invitations_check`: `CHECK ((expires_at > created_at))`
- `user_invitations_check1`: `CHECK (((accepted_at IS NULL) OR (accepted_by IS NOT NULL)))`
- `user_invitations_invited_by_fkey`: `FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE RESTRICT`
- `user_invitations_invited_phone_e164_check`: `CHECK (((invited_phone_e164 IS NULL) OR ((invited_phone_e164)::text ~ '^\+[1-9][0-9]{1,14}$'::text)))`
- `user_invitations_pkey`: `PRIMARY KEY (id)`
- `user_invitations_token_hash_key`: `UNIQUE (token_hash)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_user_invitations_100_idx ON public.user_invitations USING btree (invited_by)`
- `CREATE INDEX fk_user_invitations_99_idx ON public.user_invitations USING btree (accepted_by)`
- `CREATE UNIQUE INDEX user_invitations_pkey ON public.user_invitations USING btree (id)`
- `CREATE UNIQUE INDEX user_invitations_token_hash_key ON public.user_invitations USING btree (token_hash)`

**Referenced by**

No incoming foreign keys in this baseline.

### B. Files — 2 tables


#### `assets`

File metadata and durable storage keys. Video/image bytes live outside PostgreSQL.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `storage_key` | `text` | yes | — |
| `mime_type` | `text` | yes | — |
| `file_name` | `text` | no | — |
| `size_bytes` | `bigint` | yes | — |
| `sha256` | `varchar(64)` | no | — |
| `width_px` | `integer` | no | — |
| `height_px` | `integer` | no | — |
| `duration_seconds` | `integer` | no | — |
| `status` | `varchar(16)` | yes | `'pending'::character varying` |
| `uploaded_by` | `uuid` | no | — |
| `source_metadata` | `jsonb` | yes | `'{}'::jsonb` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `assets_duration_seconds_check`: `CHECK ((duration_seconds >= 0))`
- `assets_height_px_check`: `CHECK ((height_px > 0))`
- `assets_pkey`: `PRIMARY KEY (id)`
- `assets_sha256_check`: `CHECK (((sha256 IS NULL) OR ((sha256)::text ~ '^[a-f0-9]{64}$'::text)))`
- `assets_size_bytes_check`: `CHECK ((size_bytes >= 0))`
- `assets_status_check`: `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'ready'::character varying, 'quarantined'::character varying, 'archived'::character varying])::text[])))`
- `assets_storage_key_key`: `UNIQUE (storage_key)`
- `assets_uploaded_by_fkey`: `FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT`
- `assets_width_px_check`: `CHECK ((width_px > 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX assets_pkey ON public.assets USING btree (id)`
- `CREATE UNIQUE INDEX assets_storage_key_key ON public.assets USING btree (storage_key)`
- `CREATE INDEX fk_assets_21_idx ON public.assets USING btree (uploaded_by)`

**Referenced by**

- `achievements(icon_asset_id)` → `assets(id)`
- `announcement_assets(asset_id)` → `assets(id)`
- `asset_aliases(asset_id)` → `assets(id)`
- `courses(cover_asset_id)` → `assets(id)`
- `lesson_resources(asset_id)` → `assets(id)`
- `lessons(video_asset_id)` → `assets(id)`
- `offline_downloads(asset_id)` → `assets(id)`
- `question_assets(asset_id)` → `assets(id)`
- `user_profiles(avatar_asset_id)` → `assets(id)`

#### `asset_aliases`

External package/file aliases resolving to an existing asset.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `source_namespace` | `text` | yes | — |
| `external_id` | `text` | yes | — |
| `asset_id` | `uuid` | yes | — |

**Keys and constraints**

- `asset_aliases_asset_id_fkey`: `FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `asset_aliases_pkey`: `PRIMARY KEY (id)`
- `asset_aliases_source_namespace_external_id_key`: `UNIQUE (source_namespace, external_id)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX asset_aliases_pkey ON public.asset_aliases USING btree (id)`
- `CREATE UNIQUE INDEX asset_aliases_source_namespace_external_id_key ON public.asset_aliases USING btree (source_namespace, external_id)`
- `CREATE INDEX fk_asset_aliases_20_idx ON public.asset_aliases USING btree (asset_id)`

**Referenced by**

No incoming foreign keys in this baseline.

### C. Groups — 5 tables


#### `groups`

Learning communities independent of course access.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `title` | `text` | yes | — |
| `description` | `text` | no | — |
| `status` | `varchar(16)` | yes | `'active'::character varying` |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `groups_code_key`: `UNIQUE (code)`
- `groups_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `groups_pkey`: `PRIMARY KEY (id)`
- `groups_status_check`: `CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_groups_47_idx ON public.groups USING btree (created_by)`
- `CREATE UNIQUE INDEX groups_code_key ON public.groups USING btree (code)`
- `CREATE UNIQUE INDEX groups_pkey ON public.groups USING btree (id)`

**Referenced by**

- `ai_limit_policies(group_id)` → `groups(id)`
- `group_announcements(group_id)` → `groups(id)`
- `group_members(group_id)` → `groups(id)`
- `group_teachers(group_id)` → `groups(id)`
- `test_assignments(group_id)` → `groups(id)`

#### `group_members`

Current student membership and membership state; status changes are audited.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `group_id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `status` | `varchar(16)` | yes | `'active'::character varying` |
| `is_representative` | `boolean` | yes | `false` |
| `joined_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `left_at` | `timestamptz` | no | — |
| `added_by` | `uuid` | yes | — |

**Keys and constraints**

- `group_members_added_by_fkey`: `FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE RESTRICT`
- `group_members_group_id_fkey`: `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT`
- `group_members_group_id_user_id_key`: `UNIQUE (group_id, user_id)`
- `group_members_pkey`: `PRIMARY KEY (id)`
- `group_members_status_check`: `CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'left'::character varying, 'removed'::character varying])::text[])))`
- `group_members_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_group_members_43_idx ON public.group_members USING btree (added_by)`
- `CREATE INDEX fk_group_members_44_idx ON public.group_members USING btree (user_id)`
- `CREATE INDEX group_members_active_idx ON public.group_members USING btree (user_id, group_id) WHERE ((status)::text = 'active'::text)`
- `CREATE UNIQUE INDEX group_members_group_id_user_id_key ON public.group_members USING btree (group_id, user_id)`
- `CREATE UNIQUE INDEX group_members_pkey ON public.group_members USING btree (id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `group_teachers`

Teacher assignments and permissions within a group, independent of course permissions.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `group_id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `can_publish_announcements` | `boolean` | yes | `false` |
| `can_assign_tests` | `boolean` | yes | `false` |
| `can_view_results` | `boolean` | yes | `false` |
| `assigned_by` | `uuid` | yes | — |
| `assigned_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `group_teachers_assigned_by_fkey`: `FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT`
- `group_teachers_group_id_fkey`: `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT`
- `group_teachers_group_id_user_id_key`: `UNIQUE (group_id, user_id)`
- `group_teachers_pkey`: `PRIMARY KEY (id)`
- `group_teachers_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_group_teachers_45_idx ON public.group_teachers USING btree (assigned_by)`
- `CREATE INDEX fk_group_teachers_46_idx ON public.group_teachers USING btree (user_id)`
- `CREATE UNIQUE INDEX group_teachers_group_id_user_id_key ON public.group_teachers USING btree (group_id, user_id)`
- `CREATE UNIQUE INDEX group_teachers_pkey ON public.group_teachers USING btree (id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `group_announcements`

Teacher/admin announcements scoped to one group.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `group_id` | `uuid` | yes | — |
| `author_id` | `uuid` | yes | — |
| `title` | `text` | yes | — |
| `content` | `jsonb` | yes | `'{"blocks": []}'::jsonb` |
| `is_pinned` | `boolean` | yes | `false` |
| `status` | `varchar(16)` | yes | `'draft'::character varying` |
| `published_at` | `timestamptz` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `group_announcements_author_id_fkey`: `FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT`
- `group_announcements_group_id_fkey`: `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT`
- `group_announcements_pkey`: `PRIMARY KEY (id)`
- `group_announcements_status_check`: `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'archived'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_group_announcements_42_idx ON public.group_announcements USING btree (author_id)`
- `CREATE INDEX group_announcements_feed_idx ON public.group_announcements USING btree (group_id, is_pinned, published_at)`
- `CREATE UNIQUE INDEX group_announcements_pkey ON public.group_announcements USING btree (id)`

**Referenced by**

- `announcement_assets(announcement_id)` → `group_announcements(id)`

#### `announcement_assets`

Many-to-many attachment links between announcements and assets.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `announcement_id` | `uuid` | yes | — |
| `asset_id` | `uuid` | yes | — |

**Keys and constraints**

- `announcement_assets_announcement_id_fkey`: `FOREIGN KEY (announcement_id) REFERENCES group_announcements(id) ON DELETE RESTRICT`
- `announcement_assets_asset_id_fkey`: `FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `announcement_assets_pkey`: `PRIMARY KEY (announcement_id, asset_id)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX announcement_assets_pkey ON public.announcement_assets USING btree (announcement_id, asset_id)`
- `CREATE INDEX fk_announcement_assets_19_idx ON public.announcement_assets USING btree (asset_id)`

**Referenced by**

No incoming foreign keys in this baseline.

### D. Taxonomy — 6 tables


#### `subjects`

Stable subject identifiers and codes.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `primary_language` | `varchar(2)` | yes | `'tg'::character varying` |

**Keys and constraints**

- `subjects_code_key`: `UNIQUE (code)`
- `subjects_pkey`: `PRIMARY KEY (id)`
- `subjects_primary_language_check`: `CHECK (((primary_language)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX subjects_code_key ON public.subjects USING btree (code)`
- `CREATE UNIQUE INDEX subjects_pkey ON public.subjects USING btree (id)`

**Referenced by**

- `courses(subject_id)` → `subjects(id)`
- `question_banks(subject_id)` → `subjects(id)`
- `sections(subject_id)` → `subjects(id)`
- `subject_translations(subject_id)` → `subjects(id)`
- `topics(subject_id)` → `subjects(id)`

#### `subject_translations`

Optional translated subject names; one row per subject/language.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `subject_id` | `uuid` | yes | — |
| `language_code` | `varchar(2)` | yes | — |
| `title` | `text` | yes | — |

**Keys and constraints**

- `subject_translations_language_code_check`: `CHECK (((language_code)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `subject_translations_pkey`: `PRIMARY KEY (subject_id, language_code)`
- `subject_translations_subject_id_fkey`: `FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX subject_translations_pkey ON public.subject_translations USING btree (subject_id, language_code)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `sections`

Sections belonging to a subject.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `subject_id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `primary_language` | `varchar(2)` | yes | `'tg'::character varying` |

**Keys and constraints**

- `sections_id_subject_id_key`: `UNIQUE (id, subject_id)`
- `sections_pkey`: `PRIMARY KEY (id)`
- `sections_primary_language_check`: `CHECK (((primary_language)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `sections_subject_id_code_key`: `UNIQUE (subject_id, code)`
- `sections_subject_id_fkey`: `FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX sections_id_subject_id_key ON public.sections USING btree (id, subject_id)`
- `CREATE UNIQUE INDEX sections_pkey ON public.sections USING btree (id)`
- `CREATE UNIQUE INDEX sections_subject_id_code_key ON public.sections USING btree (subject_id, code)`

**Referenced by**

- `section_translations(section_id)` → `sections(id)`
- `topics(section_id, subject_id)` → `sections(id, subject_id)`

#### `section_translations`

Optional translated section names.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `section_id` | `uuid` | yes | — |
| `language_code` | `varchar(2)` | yes | — |
| `title` | `text` | yes | — |

**Keys and constraints**

- `section_translations_language_code_check`: `CHECK (((language_code)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `section_translations_pkey`: `PRIMARY KEY (section_id, language_code)`
- `section_translations_section_id_fkey`: `FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX section_translations_pkey ON public.section_translations USING btree (section_id, language_code)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `topics`

Subject-scoped topics and nested subtopics; composite FKs preserve subject consistency.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `subject_id` | `uuid` | yes | — |
| `section_id` | `uuid` | no | — |
| `parent_id` | `uuid` | no | — |
| `code` | `text` | yes | — |
| `primary_language` | `varchar(2)` | yes | `'tg'::character varying` |

**Keys and constraints**

- `topics_check`: `CHECK (((parent_id IS NULL) OR (parent_id <> id)))`
- `topics_id_subject_id_key`: `UNIQUE (id, subject_id)`
- `topics_parent_id_subject_id_fkey`: `FOREIGN KEY (parent_id, subject_id) REFERENCES topics(id, subject_id) ON DELETE RESTRICT`
- `topics_pkey`: `PRIMARY KEY (id)`
- `topics_primary_language_check`: `CHECK (((primary_language)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `topics_section_id_subject_id_fkey`: `FOREIGN KEY (section_id, subject_id) REFERENCES sections(id, subject_id) ON DELETE RESTRICT`
- `topics_subject_id_code_key`: `UNIQUE (subject_id, code)`
- `topics_subject_id_fkey`: `FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_topics_96_idx ON public.topics USING btree (parent_id, subject_id)`
- `CREATE INDEX fk_topics_97_idx ON public.topics USING btree (section_id, subject_id)`
- `CREATE UNIQUE INDEX topics_id_subject_id_key ON public.topics USING btree (id, subject_id)`
- `CREATE UNIQUE INDEX topics_pkey ON public.topics USING btree (id)`
- `CREATE UNIQUE INDEX topics_subject_id_code_key ON public.topics USING btree (subject_id, code)`

**Referenced by**

- `question_topics(topic_id, subject_id)` → `topics(id, subject_id)`
- `topic_translations(topic_id)` → `topics(id)`
- `topics(parent_id, subject_id)` → `topics(id, subject_id)`

#### `topic_translations`

Optional translated topic names.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `topic_id` | `uuid` | yes | — |
| `language_code` | `varchar(2)` | yes | — |
| `title` | `text` | yes | — |

**Keys and constraints**

- `topic_translations_language_code_check`: `CHECK (((language_code)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `topic_translations_pkey`: `PRIMARY KEY (topic_id, language_code)`
- `topic_translations_topic_id_fkey`: `FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX topic_translations_pkey ON public.topic_translations USING btree (topic_id, language_code)`

**Referenced by**

No incoming foreign keys in this baseline.

### E. Learning — 11 tables


#### `courses`

Independent courses with subject, publication state, cover and main-language content.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `subject_id` | `uuid` | no | — |
| `title` | `text` | yes | — |
| `description` | `text` | no | — |
| `language_code` | `varchar(2)` | yes | `'ru'::character varying` |
| `translations` | `jsonb` | yes | `'{}'::jsonb` |
| `cover_asset_id` | `uuid` | no | — |
| `status` | `varchar(16)` | yes | `'draft'::character varying` |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `courses_cover_asset_id_fkey`: `FOREIGN KEY (cover_asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `courses_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `courses_language_code_check`: `CHECK (((language_code)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `courses_pkey`: `PRIMARY KEY (id)`
- `courses_status_check`: `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'archived'::character varying])::text[])))`
- `courses_subject_id_fkey`: `FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX courses_pkey ON public.courses USING btree (id)`
- `CREATE INDEX fk_courses_39_idx ON public.courses USING btree (cover_asset_id)`
- `CREATE INDEX fk_courses_40_idx ON public.courses USING btree (created_by)`
- `CREATE INDEX fk_courses_41_idx ON public.courses USING btree (subject_id)`

**Referenced by**

- `ai_analyses(course_id)` → `courses(id)`
- `ai_conversations(course_id)` → `courses(id)`
- `ai_limit_policies(course_id)` → `courses(id)`
- `course_enrollments(course_id)` → `courses(id)`
- `course_favorites(course_id)` → `courses(id)`
- `course_modules(course_id)` → `courses(id)`
- `course_teachers(course_id)` → `courses(id)`
- `test_assignments(course_id)` → `courses(id)`

#### `course_teachers`

Teacher permissions on a specific course. Group teaching grants no automatic course permission.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `course_id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `can_manage_lessons` | `boolean` | yes | `false` |
| `can_manage_questions` | `boolean` | yes | `false` |
| `can_manage_tests` | `boolean` | yes | `false` |
| `can_view_results` | `boolean` | yes | `false` |
| `assigned_by` | `uuid` | yes | — |

**Keys and constraints**

- `course_teachers_assigned_by_fkey`: `FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT`
- `course_teachers_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `course_teachers_course_id_user_id_key`: `UNIQUE (course_id, user_id)`
- `course_teachers_pkey`: `PRIMARY KEY (id)`
- `course_teachers_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX course_teachers_course_id_user_id_key ON public.course_teachers USING btree (course_id, user_id)`
- `CREATE UNIQUE INDEX course_teachers_pkey ON public.course_teachers USING btree (id)`
- `CREATE INDEX fk_course_teachers_37_idx ON public.course_teachers USING btree (assigned_by)`
- `CREATE INDEX fk_course_teachers_38_idx ON public.course_teachers USING btree (user_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `course_enrollments`

One current administrator-issued course grant per user/course, with dates and revocation.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `course_id` | `uuid` | yes | — |
| `granted_by` | `uuid` | yes | — |
| `granted_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `begins_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | no | — |
| `revoked_by` | `uuid` | no | — |

**Keys and constraints**

- `course_enrollments_check`: `CHECK (((expires_at IS NULL) OR (expires_at > begins_at)))`
- `course_enrollments_check1`: `CHECK (((revoked_by IS NULL) OR (revoked_at IS NOT NULL)))`
- `course_enrollments_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `course_enrollments_granted_by_fkey`: `FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE RESTRICT`
- `course_enrollments_pkey`: `PRIMARY KEY (id)`
- `course_enrollments_revoked_by_fkey`: `FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE RESTRICT`
- `course_enrollments_user_id_course_id_key`: `UNIQUE (user_id, course_id)`
- `course_enrollments_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX course_enrollments_pkey ON public.course_enrollments USING btree (id)`
- `CREATE UNIQUE INDEX course_enrollments_user_id_course_id_key ON public.course_enrollments USING btree (user_id, course_id)`
- `CREATE INDEX course_enrollments_user_idx ON public.course_enrollments USING btree (user_id, expires_at)`
- `CREATE INDEX fk_course_enrollments_33_idx ON public.course_enrollments USING btree (course_id)`
- `CREATE INDEX fk_course_enrollments_34_idx ON public.course_enrollments USING btree (granted_by)`
- `CREATE INDEX fk_course_enrollments_35_idx ON public.course_enrollments USING btree (revoked_by)`

**Referenced by**

- `module_access_grants(user_id, course_id)` → `course_enrollments(user_id, course_id)`

#### `course_modules`

Ordered course modules with independently published safe metadata for locked-module cards.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `course_id` | `uuid` | yes | — |
| `title` | `text` | yes | — |
| `description` | `text` | no | — |
| `position` | `integer` | yes | — |
| `translations` | `jsonb` | yes | `'{}'::jsonb` |
| `status` | `varchar(16)` | yes | `'draft'::character varying` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `course_modules_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `course_modules_course_id_position_key`: `UNIQUE (course_id, "position")`
- `course_modules_id_course_id_key`: `UNIQUE (id, course_id)`
- `course_modules_pkey`: `PRIMARY KEY (id)`
- `course_modules_position_check`: `CHECK (("position" > 0))`
- `course_modules_status_check`: `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'archived'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX course_modules_course_id_position_key ON public.course_modules USING btree (course_id, "position")`
- `CREATE UNIQUE INDEX course_modules_id_course_id_key ON public.course_modules USING btree (id, course_id)`
- `CREATE UNIQUE INDEX course_modules_pkey ON public.course_modules USING btree (id)`

**Referenced by**

- `lessons(module_id, course_id)` → `course_modules(id, course_id)`
- `module_access_grants(module_id, course_id)` → `course_modules(id, course_id)`

#### `module_access_grants`

One separate administrator-issued module grant per user/module; composite FKs require matching course and enrollment.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `course_id` | `uuid` | yes | — |
| `module_id` | `uuid` | yes | — |
| `granted_by` | `uuid` | yes | — |
| `granted_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `begins_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | no | — |
| `revoked_by` | `uuid` | no | — |

**Keys and constraints**

- `module_access_grants_check`: `CHECK (((expires_at IS NULL) OR (expires_at > begins_at)))`
- `module_access_grants_check1`: `CHECK (((revoked_by IS NULL) OR (revoked_at IS NOT NULL)))`
- `module_access_grants_granted_by_fkey`: `FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE RESTRICT`
- `module_access_grants_module_id_course_id_fkey`: `FOREIGN KEY (module_id, course_id) REFERENCES course_modules(id, course_id) ON DELETE RESTRICT`
- `module_access_grants_pkey`: `PRIMARY KEY (id)`
- `module_access_grants_revoked_by_fkey`: `FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE RESTRICT`
- `module_access_grants_user_id_course_id_fkey`: `FOREIGN KEY (user_id, course_id) REFERENCES course_enrollments(user_id, course_id) ON DELETE RESTRICT`
- `module_access_grants_user_id_module_id_key`: `UNIQUE (user_id, module_id)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_module_access_grants_57_idx ON public.module_access_grants USING btree (granted_by)`
- `CREATE INDEX fk_module_access_grants_58_idx ON public.module_access_grants USING btree (module_id, course_id)`
- `CREATE INDEX fk_module_access_grants_59_idx ON public.module_access_grants USING btree (revoked_by)`
- `CREATE INDEX fk_module_access_grants_60_idx ON public.module_access_grants USING btree (user_id, course_id)`
- `CREATE UNIQUE INDEX module_access_grants_pkey ON public.module_access_grants USING btree (id)`
- `CREATE UNIQUE INDEX module_access_grants_user_id_module_id_key ON public.module_access_grants USING btree (user_id, module_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `lessons`

Ordered lessons inside modules, main video, content and publication state.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `module_id` | `uuid` | yes | — |
| `course_id` | `uuid` | yes | — |
| `title` | `text` | yes | — |
| `position` | `integer` | yes | — |
| `lesson_type` | `varchar(16)` | yes | — |
| `content` | `jsonb` | yes | `'{"blocks": []}'::jsonb` |
| `translations` | `jsonb` | yes | `'{}'::jsonb` |
| `video_asset_id` | `uuid` | no | — |
| `allow_offline` | `boolean` | yes | `false` |
| `status` | `varchar(16)` | yes | `'draft'::character varying` |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `lessons_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `lessons_id_course_id_key`: `UNIQUE (id, course_id)`
- `lessons_lesson_type_check`: `CHECK (((lesson_type)::text = ANY ((ARRAY['video'::character varying, 'text'::character varying, 'test'::character varying, 'mixed'::character varying])::text[])))`
- `lessons_module_id_course_id_fkey`: `FOREIGN KEY (module_id, course_id) REFERENCES course_modules(id, course_id) ON DELETE RESTRICT`
- `lessons_module_id_position_key`: `UNIQUE (module_id, "position")`
- `lessons_pkey`: `PRIMARY KEY (id)`
- `lessons_position_check`: `CHECK (("position" > 0))`
- `lessons_status_check`: `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'archived'::character varying])::text[])))`
- `lessons_video_asset_id_fkey`: `FOREIGN KEY (video_asset_id) REFERENCES assets(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_lessons_54_idx ON public.lessons USING btree (created_by)`
- `CREATE INDEX fk_lessons_55_idx ON public.lessons USING btree (module_id, course_id)`
- `CREATE INDEX fk_lessons_56_idx ON public.lessons USING btree (video_asset_id)`
- `CREATE UNIQUE INDEX lessons_id_course_id_key ON public.lessons USING btree (id, course_id)`
- `CREATE UNIQUE INDEX lessons_module_id_position_key ON public.lessons USING btree (module_id, "position")`
- `CREATE UNIQUE INDEX lessons_pkey ON public.lessons USING btree (id)`

**Referenced by**

- `learning_activity_events(lesson_id)` → `lessons(id)`
- `lesson_notes(lesson_id)` → `lessons(id)`
- `lesson_progress(lesson_id)` → `lessons(id)`
- `lesson_resources(lesson_id)` → `lessons(id)`
- `offline_downloads(lesson_id)` → `lessons(id)`
- `test_assignments(lesson_id)` → `lessons(id)`

#### `lesson_resources`

Ordered supplemental files attached to a lesson.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `lesson_id` | `uuid` | yes | — |
| `asset_id` | `uuid` | yes | — |
| `title` | `text` | no | — |
| `position` | `integer` | yes | `1` |

**Keys and constraints**

- `lesson_resources_asset_id_fkey`: `FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `lesson_resources_lesson_id_asset_id_key`: `UNIQUE (lesson_id, asset_id)`
- `lesson_resources_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE RESTRICT`
- `lesson_resources_pkey`: `PRIMARY KEY (id)`
- `lesson_resources_position_check`: `CHECK (("position" > 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_lesson_resources_53_idx ON public.lesson_resources USING btree (asset_id)`
- `CREATE UNIQUE INDEX lesson_resources_lesson_id_asset_id_key ON public.lesson_resources USING btree (lesson_id, asset_id)`
- `CREATE UNIQUE INDEX lesson_resources_pkey ON public.lesson_resources USING btree (id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `lesson_progress`

One current progress record per user/lesson, with a revision for concurrent synchronization.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `user_id` | `uuid` | yes | — |
| `lesson_id` | `uuid` | yes | — |
| `status` | `varchar(16)` | yes | `'not_started'::character varying` |
| `playback_seconds` | `integer` | yes | `0` |
| `watched_seconds` | `integer` | yes | `0` |
| `completed_at` | `timestamptz` | no | — |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `revision` | `bigint` | yes | `0` |

**Keys and constraints**

- `lesson_progress_check`: `CHECK ((((status)::text <> 'completed'::text) OR (completed_at IS NOT NULL)))`
- `lesson_progress_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE RESTRICT`
- `lesson_progress_pkey`: `PRIMARY KEY (user_id, lesson_id)`
- `lesson_progress_playback_seconds_check`: `CHECK ((playback_seconds >= 0))`
- `lesson_progress_revision_check`: `CHECK ((revision >= 0))`
- `lesson_progress_status_check`: `CHECK (((status)::text = ANY ((ARRAY['not_started'::character varying, 'in_progress'::character varying, 'completed'::character varying])::text[])))`
- `lesson_progress_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `lesson_progress_watched_seconds_check`: `CHECK ((watched_seconds >= 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_lesson_progress_52_idx ON public.lesson_progress USING btree (lesson_id)`
- `CREATE UNIQUE INDEX lesson_progress_pkey ON public.lesson_progress USING btree (user_id, lesson_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `lesson_notes`

Personal notes owned by one learner; do not expose to other learners.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `lesson_id` | `uuid` | yes | — |
| `body` | `text` | yes | — |
| `playback_seconds` | `integer` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `lesson_notes_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE RESTRICT`
- `lesson_notes_pkey`: `PRIMARY KEY (id)`
- `lesson_notes_playback_seconds_check`: `CHECK ((playback_seconds >= 0))`
- `lesson_notes_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_lesson_notes_50_idx ON public.lesson_notes USING btree (lesson_id)`
- `CREATE INDEX fk_lesson_notes_51_idx ON public.lesson_notes USING btree (user_id)`
- `CREATE UNIQUE INDEX lesson_notes_pkey ON public.lesson_notes USING btree (id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `course_favorites`

A learner's course bookmarks. A favorite does not grant access.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `user_id` | `uuid` | yes | — |
| `course_id` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `course_favorites_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `course_favorites_pkey`: `PRIMARY KEY (user_id, course_id)`
- `course_favorites_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX course_favorites_pkey ON public.course_favorites USING btree (user_id, course_id)`
- `CREATE INDEX fk_course_favorites_36_idx ON public.course_favorites USING btree (course_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `offline_downloads`

Session-bound, expiring permission for a lesson asset; requires effective learning access and offline permission.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `session_id` | `uuid` | yes | — |
| `lesson_id` | `uuid` | yes | — |
| `asset_id` | `uuid` | yes | — |
| `granted_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `lease_expires_at` | `timestamptz` | yes | — |
| `last_checked_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | no | — |

**Keys and constraints**

- `offline_downloads_asset_id_fkey`: `FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `offline_downloads_check`: `CHECK ((lease_expires_at > granted_at))`
- `offline_downloads_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE RESTRICT`
- `offline_downloads_pkey`: `PRIMARY KEY (id)`
- `offline_downloads_session_id_fkey`: `FOREIGN KEY (session_id) REFERENCES auth_sessions(id) ON DELETE RESTRICT`
- `offline_downloads_session_id_lesson_id_asset_id_key`: `UNIQUE (session_id, lesson_id, asset_id)`
- `offline_downloads_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_offline_downloads_64_idx ON public.offline_downloads USING btree (asset_id)`
- `CREATE INDEX fk_offline_downloads_65_idx ON public.offline_downloads USING btree (lesson_id)`
- `CREATE INDEX fk_offline_downloads_66_idx ON public.offline_downloads USING btree (user_id)`
- `CREATE UNIQUE INDEX offline_downloads_pkey ON public.offline_downloads USING btree (id)`
- `CREATE UNIQUE INDEX offline_downloads_session_id_lesson_id_asset_id_key ON public.offline_downloads USING btree (session_id, lesson_id, asset_id)`

**Referenced by**

No incoming foreign keys in this baseline.

### F. Questions and imports — 10 tables


#### `question_banks`

Subject-scoped question collections sourced from books or teachers.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `title` | `text` | yes | — |
| `subject_id` | `uuid` | yes | — |
| `owner_id` | `uuid` | yes | — |
| `visibility` | `varchar(16)` | yes | `'private'::character varying` |
| `source_metadata` | `jsonb` | yes | `'{}'::jsonb` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `question_banks_code_key`: `UNIQUE (code)`
- `question_banks_id_subject_id_key`: `UNIQUE (id, subject_id)`
- `question_banks_owner_id_fkey`: `FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT`
- `question_banks_pkey`: `PRIMARY KEY (id)`
- `question_banks_subject_id_fkey`: `FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT`
- `question_banks_visibility_check`: `CHECK (((visibility)::text = ANY ((ARRAY['private'::character varying, 'staff'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_question_banks_71_idx ON public.question_banks USING btree (owner_id)`
- `CREATE INDEX fk_question_banks_72_idx ON public.question_banks USING btree (subject_id)`
- `CREATE UNIQUE INDEX question_banks_code_key ON public.question_banks USING btree (code)`
- `CREATE UNIQUE INDEX question_banks_id_subject_id_key ON public.question_banks USING btree (id, subject_id)`
- `CREATE UNIQUE INDEX question_banks_pkey ON public.question_banks USING btree (id)`

**Referenced by**

- `question_imports(bank_id)` → `question_banks(id)`
- `questions(bank_id, subject_id)` → `question_banks(id, subject_id)`

#### `question_imports`

Import package manifest, idempotency, dry-run state and counters.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `bank_id` | `uuid` | yes | — |
| `initiated_by` | `uuid` | yes | — |
| `package_sha256` | `varchar(64)` | yes | — |
| `schema_version` | `text` | yes | — |
| `idempotency_key` | `text` | yes | — |
| `is_dry_run` | `boolean` | yes | `true` |
| `status` | `varchar(16)` | yes | `'pending'::character varying` |
| `manifest` | `jsonb` | yes | — |
| `counters` | `jsonb` | yes | `'{}'::jsonb` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `finished_at` | `timestamptz` | no | — |

**Keys and constraints**

- `question_imports_bank_id_fkey`: `FOREIGN KEY (bank_id) REFERENCES question_banks(id) ON DELETE RESTRICT`
- `question_imports_bank_id_idempotency_key_key`: `UNIQUE (bank_id, idempotency_key)`
- `question_imports_initiated_by_fkey`: `FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE RESTRICT`
- `question_imports_pkey`: `PRIMARY KEY (id)`
- `question_imports_status_check`: `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'validating'::character varying, 'validated'::character varying, 'importing'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_question_imports_76_idx ON public.question_imports USING btree (initiated_by)`
- `CREATE UNIQUE INDEX question_imports_bank_id_idempotency_key_key ON public.question_imports USING btree (bank_id, idempotency_key)`
- `CREATE UNIQUE INDEX question_imports_pkey ON public.question_imports USING btree (id)`

**Referenced by**

- `question_import_errors(import_id)` → `question_imports(id)`
- `questions(import_id)` → `question_imports(id)`

#### `question_import_errors`

Row/item-level import validation errors safe for administrative review.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `import_id` | `uuid` | yes | — |
| `external_id` | `text` | no | — |
| `record_path` | `text` | no | — |
| `severity` | `varchar(16)` | yes | — |
| `error_code` | `text` | yes | — |
| `message` | `text` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `question_import_errors_import_id_fkey`: `FOREIGN KEY (import_id) REFERENCES question_imports(id) ON DELETE RESTRICT`
- `question_import_errors_pkey`: `PRIMARY KEY (id)`
- `question_import_errors_severity_check`: `CHECK (((severity)::text = ANY ((ARRAY['warning'::character varying, 'error'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_question_import_errors_75_idx ON public.question_import_errors USING btree (import_id)`
- `CREATE UNIQUE INDEX question_import_errors_pkey ON public.question_import_errors USING btree (id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `questions`

Question content, type, language, source metadata and publication state. Published corrections use a new copy.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `bank_id` | `uuid` | yes | — |
| `subject_id` | `uuid` | yes | — |
| `external_id` | `text` | no | — |
| `question_type` | `varchar(24)` | yes | — |
| `language_code` | `varchar(2)` | yes | — |
| `difficulty` | `smallint` | no | — |
| `difficulty_source` | `varchar(16)` | no | — |
| `status` | `varchar(16)` | yes | `'draft'::character varying` |
| `content` | `jsonb` | yes | `'{"blocks": []}'::jsonb` |
| `interaction_settings` | `jsonb` | yes | `'{}'::jsonb` |
| `source_metadata` | `jsonb` | yes | `'{}'::jsonb` |
| `source_question_id` | `uuid` | no | — |
| `import_id` | `uuid` | no | — |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `questions_bank_id_external_id_key`: `UNIQUE (bank_id, external_id)`
- `questions_bank_id_subject_id_fkey`: `FOREIGN KEY (bank_id, subject_id) REFERENCES question_banks(id, subject_id) ON DELETE RESTRICT`
- `questions_check`: `CHECK (((difficulty IS NULL) = (difficulty_source IS NULL)))`
- `questions_check1`: `CHECK (((source_question_id IS NULL) OR (source_question_id <> id)))`
- `questions_content_check`: `CHECK ((jsonb_typeof(content) = 'object'::text))`
- `questions_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `questions_difficulty_check`: `CHECK (((difficulty >= 1) AND (difficulty <= 5)))`
- `questions_difficulty_source_check`: `CHECK (((difficulty_source)::text = ANY ((ARRAY['ai'::character varying, 'expert'::character varying, 'official'::character varying])::text[])))`
- `questions_id_subject_id_key`: `UNIQUE (id, subject_id)`
- `questions_import_id_fkey`: `FOREIGN KEY (import_id) REFERENCES question_imports(id) ON DELETE RESTRICT`
- `questions_interaction_settings_check`: `CHECK ((jsonb_typeof(interaction_settings) = 'object'::text))`
- `questions_language_code_check`: `CHECK (((language_code)::text = ANY ((ARRAY['tg'::character varying, 'ru'::character varying, 'en'::character varying])::text[])))`
- `questions_pkey`: `PRIMARY KEY (id)`
- `questions_question_type_check`: `CHECK (((question_type)::text = ANY ((ARRAY['single_choice'::character varying, 'multiple_choice'::character varying, 'matching'::character varying, 'numeric'::character varying, 'short_text'::character varying])::text[])))`
- `questions_source_question_id_fkey`: `FOREIGN KEY (source_question_id) REFERENCES questions(id) ON DELETE RESTRICT`
- `questions_status_check`: `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'archived'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_questions_79_idx ON public.questions USING btree (bank_id, subject_id)`
- `CREATE INDEX fk_questions_80_idx ON public.questions USING btree (created_by)`
- `CREATE INDEX fk_questions_81_idx ON public.questions USING btree (import_id)`
- `CREATE INDEX fk_questions_82_idx ON public.questions USING btree (source_question_id)`
- `CREATE UNIQUE INDEX questions_bank_id_external_id_key ON public.questions USING btree (bank_id, external_id)`
- `CREATE INDEX questions_filter_idx ON public.questions USING btree (bank_id, status, question_type, language_code, difficulty)`
- `CREATE UNIQUE INDEX questions_id_subject_id_key ON public.questions USING btree (id, subject_id)`
- `CREATE UNIQUE INDEX questions_pkey ON public.questions USING btree (id)`
- `CREATE INDEX questions_subject_idx ON public.questions USING btree (subject_id, status)`

**Referenced by**

- `question_answer_keys(question_id)` → `questions(id)`
- `question_assets(question_id)` → `questions(id)`
- `question_duplicate_links(duplicate_of_id)` → `questions(id)`
- `question_duplicate_links(question_id)` → `questions(id)`
- `question_matching_items(question_id)` → `questions(id)`
- `question_options(question_id)` → `questions(id)`
- `question_topics(question_id, subject_id)` → `questions(id, subject_id)`
- `questions(source_question_id)` → `questions(id)`
- `test_questions(question_id)` → `questions(id)`

#### `question_options`

Ordered answer options; these contain no is_correct flag.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `question_id` | `uuid` | yes | — |
| `option_key` | `text` | yes | — |
| `position` | `integer` | yes | — |
| `source_label` | `text` | no | — |
| `content` | `jsonb` | yes | `'{"blocks": []}'::jsonb` |

**Keys and constraints**

- `question_options_id_question_id_key`: `UNIQUE (id, question_id)`
- `question_options_pkey`: `PRIMARY KEY (id)`
- `question_options_position_check`: `CHECK (("position" > 0))`
- `question_options_question_id_fkey`: `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT`
- `question_options_question_id_option_key_key`: `UNIQUE (question_id, option_key)`
- `question_options_question_id_position_key`: `UNIQUE (question_id, "position")`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX question_options_id_question_id_key ON public.question_options USING btree (id, question_id)`
- `CREATE UNIQUE INDEX question_options_pkey ON public.question_options USING btree (id)`
- `CREATE UNIQUE INDEX question_options_question_id_option_key_key ON public.question_options USING btree (question_id, option_key)`
- `CREATE UNIQUE INDEX question_options_question_id_position_key ON public.question_options USING btree (question_id, "position")`

**Referenced by**

No incoming foreign keys in this baseline.

#### `question_matching_items`

Ordered left/right items for matching questions.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `question_id` | `uuid` | yes | — |
| `side` | `varchar(5)` | yes | — |
| `item_key` | `text` | yes | — |
| `position` | `integer` | yes | — |
| `source_label` | `text` | no | — |
| `content` | `jsonb` | yes | `'{"blocks": []}'::jsonb` |

**Keys and constraints**

- `question_matching_items_id_question_id_key`: `UNIQUE (id, question_id)`
- `question_matching_items_pkey`: `PRIMARY KEY (id)`
- `question_matching_items_position_check`: `CHECK (("position" > 0))`
- `question_matching_items_question_id_fkey`: `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT`
- `question_matching_items_question_id_side_item_key_key`: `UNIQUE (question_id, side, item_key)`
- `question_matching_items_question_id_side_position_key`: `UNIQUE (question_id, side, "position")`
- `question_matching_items_side_check`: `CHECK (((side)::text = ANY ((ARRAY['left'::character varying, 'right'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX question_matching_items_id_question_id_key ON public.question_matching_items USING btree (id, question_id)`
- `CREATE UNIQUE INDEX question_matching_items_pkey ON public.question_matching_items USING btree (id)`
- `CREATE UNIQUE INDEX question_matching_items_question_id_side_item_key_key ON public.question_matching_items USING btree (question_id, side, item_key)`
- `CREATE UNIQUE INDEX question_matching_items_question_id_side_position_key ON public.question_matching_items USING btree (question_id, side, "position")`

**Referenced by**

No incoming foreign keys in this baseline.

#### `question_answer_keys`

The sole editable authoring source of correctness, explanations, verification state and reviewer.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `question_id` | `uuid` | yes | — |
| `status` | `varchar(16)` | yes | `'unknown'::character varying` |
| `source` | `varchar(24)` | yes | `'none'::character varying` |
| `answer_data` | `jsonb` | no | — |
| `explanation` | `jsonb` | yes | `'{"blocks": []}'::jsonb` |
| `verified_by` | `uuid` | no | — |
| `verified_at` | `timestamptz` | no | — |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `question_answer_keys_answer_data_check`: `CHECK (((answer_data IS NULL) OR (jsonb_typeof(answer_data) = 'object'::text)))`
- `question_answer_keys_check`: `CHECK ((((status)::text = 'unknown'::text) OR (answer_data IS NOT NULL)))`
- `question_answer_keys_check1`: `CHECK ((((status)::text <> 'verified'::text) OR ((verified_by IS NOT NULL) AND (verified_at IS NOT NULL) AND ((source)::text <> 'none'::text))))`
- `question_answer_keys_pkey`: `PRIMARY KEY (question_id)`
- `question_answer_keys_question_id_fkey`: `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT`
- `question_answer_keys_source_check`: `CHECK (((source)::text = ANY ((ARRAY['none'::character varying, 'official_key'::character varying, 'expert_review'::character varying, 'ai_inference'::character varying])::text[])))`
- `question_answer_keys_status_check`: `CHECK (((status)::text = ANY ((ARRAY['unknown'::character varying, 'proposed'::character varying, 'verified'::character varying])::text[])))`
- `question_answer_keys_verified_by_fkey`: `FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_question_answer_keys_69_idx ON public.question_answer_keys USING btree (verified_by)`
- `CREATE UNIQUE INDEX question_answer_keys_pkey ON public.question_answer_keys USING btree (question_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `question_topics`

Many-to-many question/topic classifications within the same subject.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `question_id` | `uuid` | yes | — |
| `topic_id` | `uuid` | yes | — |
| `subject_id` | `uuid` | yes | — |

**Keys and constraints**

- `question_topics_pkey`: `PRIMARY KEY (question_id, topic_id)`
- `question_topics_question_id_subject_id_fkey`: `FOREIGN KEY (question_id, subject_id) REFERENCES questions(id, subject_id) ON DELETE RESTRICT`
- `question_topics_topic_id_subject_id_fkey`: `FOREIGN KEY (topic_id, subject_id) REFERENCES topics(id, subject_id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_question_topics_77_idx ON public.question_topics USING btree (question_id, subject_id)`
- `CREATE INDEX fk_question_topics_78_idx ON public.question_topics USING btree (topic_id, subject_id)`
- `CREATE UNIQUE INDEX question_topics_pkey ON public.question_topics USING btree (question_id, topic_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `question_assets`

Question-linked images/audio and other assets.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `question_id` | `uuid` | yes | — |
| `asset_id` | `uuid` | yes | — |

**Keys and constraints**

- `question_assets_asset_id_fkey`: `FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `question_assets_pkey`: `PRIMARY KEY (question_id, asset_id)`
- `question_assets_question_id_fkey`: `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_question_assets_70_idx ON public.question_assets USING btree (asset_id)`
- `CREATE UNIQUE INDEX question_assets_pkey ON public.question_assets USING btree (question_id, asset_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `question_duplicate_links`

Explicit relationships between suspected or confirmed duplicate questions.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `question_id` | `uuid` | yes | — |
| `duplicate_of_id` | `uuid` | yes | — |
| `reason` | `text` | no | — |
| `marked_by` | `uuid` | yes | — |

**Keys and constraints**

- `question_duplicate_links_check`: `CHECK ((question_id <> duplicate_of_id))`
- `question_duplicate_links_duplicate_of_id_fkey`: `FOREIGN KEY (duplicate_of_id) REFERENCES questions(id) ON DELETE RESTRICT`
- `question_duplicate_links_marked_by_fkey`: `FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE RESTRICT`
- `question_duplicate_links_pkey`: `PRIMARY KEY (question_id, duplicate_of_id)`
- `question_duplicate_links_question_id_fkey`: `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_question_duplicate_links_73_idx ON public.question_duplicate_links USING btree (duplicate_of_id)`
- `CREATE INDEX fk_question_duplicate_links_74_idx ON public.question_duplicate_links USING btree (marked_by)`
- `CREATE UNIQUE INDEX question_duplicate_links_pkey ON public.question_duplicate_links USING btree (question_id, duplicate_of_id)`

**Referenced by**

No incoming foreign keys in this baseline.

### G. Tests and attempts — 7 tables


#### `tests`

Reusable immutable-on-publication test definitions, timing, result and grading policies.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `title` | `text` | yes | — |
| `mode` | `varchar(16)` | yes | — |
| `status` | `varchar(16)` | yes | `'draft'::character varying` |
| `duration_seconds` | `integer` | no | — |
| `max_attempts` | `integer` | no | — |
| `result_policy` | `varchar(16)` | yes | `'first'::character varying` |
| `answer_reveal_policy` | `varchar(24)` | yes | `'after_submission'::character varying` |
| `shuffle_questions` | `boolean` | yes | `false` |
| `shuffle_options` | `boolean` | yes | `false` |
| `grading_policy` | `jsonb` | yes | `'{}'::jsonb` |
| `generation_filters` | `jsonb` | yes | `'{}'::jsonb` |
| `copied_from_id` | `uuid` | no | — |
| `created_by` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `tests_answer_reveal_policy_check`: `CHECK (((answer_reveal_policy)::text = ANY ((ARRAY['after_answer'::character varying, 'after_submission'::character varying, 'after_window'::character varying, 'never'::character varying])::text[])))`
- `tests_check`: `CHECK ((((mode)::text <> ALL ((ARRAY['exam'::character varying, 'nct'::character varying])::text[])) OR (duration_seconds IS NOT NULL)))`
- `tests_check1`: `CHECK ((((mode)::text <> ALL ((ARRAY['exam'::character varying, 'nct'::character varying])::text[])) OR ((answer_reveal_policy)::text <> 'after_answer'::text)))`
- `tests_copied_from_id_fkey`: `FOREIGN KEY (copied_from_id) REFERENCES tests(id) ON DELETE RESTRICT`
- `tests_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `tests_duration_seconds_check`: `CHECK ((duration_seconds > 0))`
- `tests_max_attempts_check`: `CHECK ((max_attempts > 0))`
- `tests_mode_check`: `CHECK (((mode)::text = ANY ((ARRAY['lesson'::character varying, 'practice'::character varying, 'exam'::character varying, 'nct'::character varying])::text[])))`
- `tests_pkey`: `PRIMARY KEY (id)`
- `tests_result_policy_check`: `CHECK (((result_policy)::text = ANY ((ARRAY['first'::character varying, 'best'::character varying, 'last'::character varying])::text[])))`
- `tests_status_check`: `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'archived'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_tests_94_idx ON public.tests USING btree (copied_from_id)`
- `CREATE INDEX fk_tests_95_idx ON public.tests USING btree (created_by)`
- `CREATE UNIQUE INDEX tests_pkey ON public.tests USING btree (id)`

**Referenced by**

- `test_assignments(test_id)` → `tests(id)`
- `test_attempts(test_id)` → `tests(id)`
- `test_questions(test_id)` → `tests(id)`
- `tests(copied_from_id)` → `tests(id)`

#### `test_questions`

Ordered question composition and points for a test.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `test_id` | `uuid` | yes | — |
| `question_id` | `uuid` | yes | — |
| `position` | `integer` | yes | — |
| `points` | `numeric(10,2)` | yes | — |

**Keys and constraints**

- `test_questions_id_test_id_question_id_key`: `UNIQUE (id, test_id, question_id)`
- `test_questions_pkey`: `PRIMARY KEY (id)`
- `test_questions_points_check`: `CHECK ((points > (0)::numeric))`
- `test_questions_position_check`: `CHECK (("position" > 0))`
- `test_questions_question_id_fkey`: `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT`
- `test_questions_test_id_fkey`: `FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE RESTRICT`
- `test_questions_test_id_position_key`: `UNIQUE (test_id, "position")`
- `test_questions_test_id_question_id_key`: `UNIQUE (test_id, question_id)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_test_questions_93_idx ON public.test_questions USING btree (question_id)`
- `CREATE UNIQUE INDEX test_questions_id_test_id_question_id_key ON public.test_questions USING btree (id, test_id, question_id)`
- `CREATE UNIQUE INDEX test_questions_pkey ON public.test_questions USING btree (id)`
- `CREATE UNIQUE INDEX test_questions_test_id_position_key ON public.test_questions USING btree (test_id, "position")`
- `CREATE UNIQUE INDEX test_questions_test_id_question_id_key ON public.test_questions USING btree (test_id, question_id)`

**Referenced by**

- `attempt_questions(test_question_id, test_id, question_id)` → `test_questions(id, test_id, question_id)`

#### `test_assignments`

One test assigned to exactly one audience kind: user, group, course or lesson.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `test_id` | `uuid` | yes | — |
| `course_id` | `uuid` | no | — |
| `lesson_id` | `uuid` | no | — |
| `group_id` | `uuid` | no | — |
| `user_id` | `uuid` | no | — |
| `assigned_by` | `uuid` | yes | — |
| `status` | `varchar(16)` | yes | `'active'::character varying` |
| `opens_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `closes_at` | `timestamptz` | no | — |
| `counts_for_group_ranking` | `boolean` | yes | `false` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `test_assignments_assigned_by_fkey`: `FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT`
- `test_assignments_check`: `CHECK ((num_nonnulls(course_id, lesson_id, group_id, user_id) = 1))`
- `test_assignments_check1`: `CHECK (((closes_at IS NULL) OR (closes_at > opens_at)))`
- `test_assignments_check2`: `CHECK (((NOT counts_for_group_ranking) OR (group_id IS NOT NULL)))`
- `test_assignments_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `test_assignments_group_id_fkey`: `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT`
- `test_assignments_id_test_id_key`: `UNIQUE (id, test_id)`
- `test_assignments_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE RESTRICT`
- `test_assignments_pkey`: `PRIMARY KEY (id)`
- `test_assignments_status_check`: `CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying, 'closed'::character varying])::text[])))`
- `test_assignments_test_id_fkey`: `FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE RESTRICT`
- `test_assignments_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_test_assignments_85_idx ON public.test_assignments USING btree (assigned_by)`
- `CREATE INDEX fk_test_assignments_86_idx ON public.test_assignments USING btree (course_id)`
- `CREATE INDEX fk_test_assignments_87_idx ON public.test_assignments USING btree (group_id)`
- `CREATE INDEX fk_test_assignments_88_idx ON public.test_assignments USING btree (lesson_id)`
- `CREATE INDEX fk_test_assignments_89_idx ON public.test_assignments USING btree (test_id)`
- `CREATE INDEX fk_test_assignments_90_idx ON public.test_assignments USING btree (user_id)`
- `CREATE UNIQUE INDEX test_assignments_id_test_id_key ON public.test_assignments USING btree (id, test_id)`
- `CREATE UNIQUE INDEX test_assignments_pkey ON public.test_assignments USING btree (id)`

**Referenced by**

- `test_attempts(assignment_id, test_id)` → `test_assignments(id, test_id)`

#### `test_attempts`

A learner's execution of an assignment: sequence, lifecycle, server timing and policy snapshot.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `test_id` | `uuid` | yes | — |
| `assignment_id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `attempt_number` | `integer` | yes | — |
| `status` | `varchar(16)` | yes | `'in_progress'::character varying` |
| `started_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | no | — |
| `paused_at` | `timestamptz` | no | — |
| `paused_seconds` | `integer` | yes | `0` |
| `submitted_at` | `timestamptz` | no | — |
| `graded_at` | `timestamptz` | no | — |
| `score` | `numeric(12,2)` | no | — |
| `max_score` | `numeric(12,2)` | no | — |
| `policy_snapshot` | `jsonb` | yes | — |

**Keys and constraints**

- `test_attempts_assignment_id_test_id_fkey`: `FOREIGN KEY (assignment_id, test_id) REFERENCES test_assignments(id, test_id) ON DELETE RESTRICT`
- `test_attempts_assignment_id_user_id_attempt_number_key`: `UNIQUE (assignment_id, user_id, attempt_number)`
- `test_attempts_attempt_number_check`: `CHECK ((attempt_number > 0))`
- `test_attempts_check`: `CHECK (((expires_at IS NULL) OR (expires_at > started_at)))`
- `test_attempts_check1`: `CHECK (((score IS NULL) OR (max_score IS NULL) OR (score <= max_score)))`
- `test_attempts_check2`: `CHECK ((((status)::text <> 'paused'::text) OR (paused_at IS NOT NULL)))`
- `test_attempts_check3`: `CHECK ((((status)::text <> 'graded'::text) OR ((score IS NOT NULL) AND (max_score IS NOT NULL) AND (graded_at IS NOT NULL))))`
- `test_attempts_id_test_id_key`: `UNIQUE (id, test_id)`
- `test_attempts_max_score_check`: `CHECK ((max_score > (0)::numeric))`
- `test_attempts_paused_seconds_check`: `CHECK ((paused_seconds >= 0))`
- `test_attempts_pkey`: `PRIMARY KEY (id)`
- `test_attempts_score_check`: `CHECK ((score >= (0)::numeric))`
- `test_attempts_status_check`: `CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'paused'::character varying, 'submitted'::character varying, 'expired'::character varying, 'graded'::character varying, 'cancelled'::character varying])::text[])))`
- `test_attempts_test_id_fkey`: `FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE RESTRICT`
- `test_attempts_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX attempts_one_open_idx ON public.test_attempts USING btree (assignment_id, user_id) WHERE ((status)::text = ANY ((ARRAY['in_progress'::character varying, 'paused'::character varying])::text[]))`
- `CREATE INDEX attempts_user_history_idx ON public.test_attempts USING btree (user_id, started_at)`
- `CREATE INDEX fk_test_attempts_91_idx ON public.test_attempts USING btree (assignment_id, test_id)`
- `CREATE INDEX fk_test_attempts_92_idx ON public.test_attempts USING btree (test_id)`
- `CREATE UNIQUE INDEX test_attempts_assignment_id_user_id_attempt_number_key ON public.test_attempts USING btree (assignment_id, user_id, attempt_number)`
- `CREATE UNIQUE INDEX test_attempts_id_test_id_key ON public.test_attempts USING btree (id, test_id)`
- `CREATE UNIQUE INDEX test_attempts_pkey ON public.test_attempts USING btree (id)`

**Referenced by**

- `ai_analyses(attempt_id)` → `test_attempts(id)`
- `attempt_questions(attempt_id, test_id)` → `test_attempts(id, test_id)`
- `attempt_score_revisions(attempt_id)` → `test_attempts(id)`
- `learning_activity_events(attempt_id)` → `test_attempts(id)`

#### `attempt_questions`

Frozen question order, option order, point limit and private grading evidence for one attempt.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `attempt_id` | `uuid` | yes | — |
| `test_id` | `uuid` | yes | — |
| `test_question_id` | `uuid` | yes | — |
| `question_id` | `uuid` | yes | — |
| `position` | `integer` | yes | — |
| `option_order` | `jsonb` | yes | `'[]'::jsonb` |
| `matching_order` | `jsonb` | yes | `'{}'::jsonb` |
| `max_points` | `numeric(10,2)` | yes | — |
| `grading_snapshot` | `jsonb` | yes | — |

**Keys and constraints**

- `attempt_questions_attempt_id_position_key`: `UNIQUE (attempt_id, "position")`
- `attempt_questions_attempt_id_test_id_fkey`: `FOREIGN KEY (attempt_id, test_id) REFERENCES test_attempts(id, test_id) ON DELETE RESTRICT`
- `attempt_questions_attempt_id_test_question_id_key`: `UNIQUE (attempt_id, test_question_id)`
- `attempt_questions_grading_snapshot_check`: `CHECK ((jsonb_typeof(grading_snapshot) = 'object'::text))`
- `attempt_questions_id_question_id_key`: `UNIQUE (id, question_id)`
- `attempt_questions_max_points_check`: `CHECK ((max_points > (0)::numeric))`
- `attempt_questions_option_order_check`: `CHECK ((jsonb_typeof(option_order) = 'array'::text))`
- `attempt_questions_pkey`: `PRIMARY KEY (id)`
- `attempt_questions_position_check`: `CHECK (("position" > 0))`
- `attempt_questions_test_question_id_test_id_question_id_fkey`: `FOREIGN KEY (test_question_id, test_id, question_id) REFERENCES test_questions(id, test_id, question_id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX attempt_questions_attempt_id_position_key ON public.attempt_questions USING btree (attempt_id, "position")`
- `CREATE UNIQUE INDEX attempt_questions_attempt_id_test_question_id_key ON public.attempt_questions USING btree (attempt_id, test_question_id)`
- `CREATE UNIQUE INDEX attempt_questions_id_question_id_key ON public.attempt_questions USING btree (id, question_id)`
- `CREATE UNIQUE INDEX attempt_questions_pkey ON public.attempt_questions USING btree (id)`
- `CREATE INDEX fk_attempt_questions_22_idx ON public.attempt_questions USING btree (attempt_id, test_id)`
- `CREATE INDEX fk_attempt_questions_23_idx ON public.attempt_questions USING btree (test_question_id, test_id, question_id)`

**Referenced by**

- `student_answers(attempt_question_id, question_id)` → `attempt_questions(id, question_id)`

#### `student_answers`

One current answer per attempt question, autosave revision and grading outcome.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `attempt_question_id` | `uuid` | yes | — |
| `question_id` | `uuid` | yes | — |
| `answer_data` | `jsonb` | no | — |
| `awarded_points` | `numeric(10,2)` | no | — |
| `grading_status` | `varchar(16)` | yes | `'pending'::character varying` |
| `revision` | `bigint` | yes | `0` |
| `saved_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `graded_by` | `uuid` | no | — |
| `graded_at` | `timestamptz` | no | — |

**Keys and constraints**

- `student_answers_attempt_question_id_question_id_fkey`: `FOREIGN KEY (attempt_question_id, question_id) REFERENCES attempt_questions(id, question_id) ON DELETE RESTRICT`
- `student_answers_awarded_points_check`: `CHECK ((awarded_points >= (0)::numeric))`
- `student_answers_graded_by_fkey`: `FOREIGN KEY (graded_by) REFERENCES users(id) ON DELETE RESTRICT`
- `student_answers_grading_status_check`: `CHECK (((grading_status)::text = ANY ((ARRAY['pending'::character varying, 'auto'::character varying, 'manual'::character varying, 'needs_review'::character varying])::text[])))`
- `student_answers_pkey`: `PRIMARY KEY (attempt_question_id)`
- `student_answers_revision_check`: `CHECK ((revision >= 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_student_answers_83_idx ON public.student_answers USING btree (attempt_question_id, question_id)`
- `CREATE INDEX fk_student_answers_84_idx ON public.student_answers USING btree (graded_by)`
- `CREATE UNIQUE INDEX student_answers_pkey ON public.student_answers USING btree (attempt_question_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `attempt_score_revisions`

Append-only history of authorized result recalculation.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `attempt_id` | `uuid` | yes | — |
| `revised_by` | `uuid` | yes | — |
| `reason` | `text` | yes | — |
| `previous_score` | `numeric(12,2)` | no | — |
| `new_score` | `numeric(12,2)` | yes | — |
| `grading_snapshot` | `jsonb` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `idempotency_key` | `text` | yes | — |

**Keys and constraints**

- `attempt_score_revisions_attempt_id_fkey`: `FOREIGN KEY (attempt_id) REFERENCES test_attempts(id) ON DELETE RESTRICT`
- `attempt_score_revisions_idempotency_key_key`: `UNIQUE (idempotency_key)`
- `attempt_score_revisions_new_score_check`: `CHECK ((new_score >= (0)::numeric))`
- `attempt_score_revisions_pkey`: `PRIMARY KEY (id)`
- `attempt_score_revisions_revised_by_fkey`: `FOREIGN KEY (revised_by) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX attempt_score_revisions_idempotency_key_key ON public.attempt_score_revisions USING btree (idempotency_key)`
- `CREATE UNIQUE INDEX attempt_score_revisions_pkey ON public.attempt_score_revisions USING btree (id)`
- `CREATE INDEX fk_attempt_score_revisions_24_idx ON public.attempt_score_revisions USING btree (attempt_id)`
- `CREATE INDEX fk_attempt_score_revisions_25_idx ON public.attempt_score_revisions USING btree (revised_by)`

**Referenced by**

No incoming foreign keys in this baseline.

### H. AI core — 9 tables


#### `ai_conversations`

Private chat threads, optionally scoped to a course.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `course_id` | `uuid` | no | — |
| `title` | `text` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `archived_at` | `timestamptz` | no | — |

**Keys and constraints**

- `ai_conversations_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `ai_conversations_id_user_id_key`: `UNIQUE (id, user_id)`
- `ai_conversations_pkey`: `PRIMARY KEY (id)`
- `ai_conversations_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_conversations_id_user_id_key ON public.ai_conversations USING btree (id, user_id)`
- `CREATE UNIQUE INDEX ai_conversations_pkey ON public.ai_conversations USING btree (id)`
- `CREATE INDEX fk_ai_conversations_5_idx ON public.ai_conversations USING btree (course_id)`
- `CREATE INDEX fk_ai_conversations_6_idx ON public.ai_conversations USING btree (user_id)`

**Referenced by**

- `ai_messages(conversation_id, user_id)` → `ai_conversations(id, user_id)`
- `ai_requests(conversation_id, user_id)` → `ai_conversations(id, user_id)`

#### `ai_messages`

Messages belonging to the same conversation owner; history is persisted.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `conversation_id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `role` | `varchar(16)` | yes | — |
| `content` | `jsonb` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `ai_messages_conversation_id_user_id_fkey`: `FOREIGN KEY (conversation_id, user_id) REFERENCES ai_conversations(id, user_id) ON DELETE RESTRICT`
- `ai_messages_id_conversation_id_user_id_key`: `UNIQUE (id, conversation_id, user_id)`
- `ai_messages_pkey`: `PRIMARY KEY (id)`
- `ai_messages_role_check`: `CHECK (((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying, 'system'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX ai_messages_history_idx ON public.ai_messages USING btree (conversation_id, created_at)`
- `CREATE UNIQUE INDEX ai_messages_id_conversation_id_user_id_key ON public.ai_messages USING btree (id, conversation_id, user_id)`
- `CREATE UNIQUE INDEX ai_messages_pkey ON public.ai_messages USING btree (id)`
- `CREATE INDEX fk_ai_messages_13_idx ON public.ai_messages USING btree (conversation_id, user_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `ai_limit_policies`

Daily usage policies for global/group/course/user scopes; shared-pool interpretation remains provisional.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `group_id` | `uuid` | no | — |
| `course_id` | `uuid` | no | — |
| `user_id` | `uuid` | no | — |
| `max_daily_requests` | `integer` | no | — |
| `max_daily_tokens` | `bigint` | no | — |
| `max_daily_cost_microunits` | `bigint` | no | — |
| `timezone` | `varchar(64)` | yes | `'Asia/Dushanbe'::character varying` |
| `is_active` | `boolean` | yes | `true` |
| `created_by` | `uuid` | yes | — |

**Keys and constraints**

- `ai_limit_policies_check`: `CHECK ((num_nonnulls(group_id, course_id, user_id) <= 1))`
- `ai_limit_policies_check1`: `CHECK ((num_nonnulls(max_daily_requests, max_daily_tokens, max_daily_cost_microunits) > 0))`
- `ai_limit_policies_code_key`: `UNIQUE (code)`
- `ai_limit_policies_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `ai_limit_policies_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `ai_limit_policies_group_id_fkey`: `FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT`
- `ai_limit_policies_max_daily_cost_microunits_check`: `CHECK ((max_daily_cost_microunits >= 0))`
- `ai_limit_policies_max_daily_requests_check`: `CHECK ((max_daily_requests >= 0))`
- `ai_limit_policies_max_daily_tokens_check`: `CHECK ((max_daily_tokens >= 0))`
- `ai_limit_policies_pkey`: `PRIMARY KEY (id)`
- `ai_limit_policies_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_limit_policies_code_key ON public.ai_limit_policies USING btree (code)`
- `CREATE UNIQUE INDEX ai_limit_policies_pkey ON public.ai_limit_policies USING btree (id)`
- `CREATE INDEX fk_ai_limit_policies_10_idx ON public.ai_limit_policies USING btree (created_by)`
- `CREATE INDEX fk_ai_limit_policies_11_idx ON public.ai_limit_policies USING btree (group_id)`
- `CREATE INDEX fk_ai_limit_policies_12_idx ON public.ai_limit_policies USING btree (user_id)`
- `CREATE INDEX fk_ai_limit_policies_9_idx ON public.ai_limit_policies USING btree (course_id)`

**Referenced by**

- `ai_daily_usage(policy_id)` → `ai_limit_policies(id)`

#### `ai_budget_periods`

Provider/currency cash budgets with reserved and spent integer microunits.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `provider_code` | `text` | yes | — |
| `currency` | `varchar(3)` | yes | — |
| `begins_at` | `timestamptz` | yes | — |
| `ends_at` | `timestamptz` | yes | — |
| `limit_microunits` | `bigint` | yes | — |
| `reserved_microunits` | `bigint` | yes | `0` |
| `spent_microunits` | `bigint` | yes | `0` |
| `is_active` | `boolean` | yes | `true` |

**Keys and constraints**

- `ai_budget_periods_check`: `CHECK ((ends_at > begins_at))`
- `ai_budget_periods_limit_microunits_check`: `CHECK ((limit_microunits >= 0))`
- `ai_budget_periods_pkey`: `PRIMARY KEY (id)`
- `ai_budget_periods_provider_code_currency_begins_at_key`: `UNIQUE (provider_code, currency, begins_at)`
- `ai_budget_periods_reserved_microunits_check`: `CHECK ((reserved_microunits >= 0))`
- `ai_budget_periods_spent_microunits_check`: `CHECK ((spent_microunits >= 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_budget_periods_pkey ON public.ai_budget_periods USING btree (id)`
- `CREATE UNIQUE INDEX ai_budget_periods_provider_code_currency_begins_at_key ON public.ai_budget_periods USING btree (provider_code, currency, begins_at)`

**Referenced by**

- `ai_requests(budget_period_id)` → `ai_budget_periods(id)`

#### `ai_daily_usage`

Usage and reservation counters for a policy-local calendar day.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `policy_id` | `uuid` | yes | — |
| `usage_date` | `date` | yes | — |
| `used_requests` | `integer` | yes | `0` |
| `reserved_requests` | `integer` | yes | `0` |
| `used_tokens` | `bigint` | yes | `0` |
| `reserved_tokens` | `bigint` | yes | `0` |
| `used_cost_microunits` | `bigint` | yes | `0` |
| `reserved_cost_microunits` | `bigint` | yes | `0` |
| `limits_snapshot` | `jsonb` | yes | — |

**Keys and constraints**

- `ai_daily_usage_pkey`: `PRIMARY KEY (id)`
- `ai_daily_usage_policy_id_fkey`: `FOREIGN KEY (policy_id) REFERENCES ai_limit_policies(id) ON DELETE RESTRICT`
- `ai_daily_usage_policy_id_usage_date_key`: `UNIQUE (policy_id, usage_date)`
- `ai_daily_usage_reserved_cost_microunits_check`: `CHECK ((reserved_cost_microunits >= 0))`
- `ai_daily_usage_reserved_requests_check`: `CHECK ((reserved_requests >= 0))`
- `ai_daily_usage_reserved_tokens_check`: `CHECK ((reserved_tokens >= 0))`
- `ai_daily_usage_used_cost_microunits_check`: `CHECK ((used_cost_microunits >= 0))`
- `ai_daily_usage_used_requests_check`: `CHECK ((used_requests >= 0))`
- `ai_daily_usage_used_tokens_check`: `CHECK ((used_tokens >= 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_daily_usage_pkey ON public.ai_daily_usage USING btree (id)`
- `CREATE UNIQUE INDEX ai_daily_usage_policy_id_usage_date_key ON public.ai_daily_usage USING btree (policy_id, usage_date)`

**Referenced by**

- `ai_request_reservations(daily_usage_id)` → `ai_daily_usage(id)`

#### `ai_requests`

Provider call lifecycle, idempotency, model, cost and optional bonus credit package.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `conversation_id` | `uuid` | yes | — |
| `budget_period_id` | `uuid` | yes | — |
| `provider_code` | `text` | yes | — |
| `model_code` | `text` | yes | — |
| `provider_request_id` | `text` | no | — |
| `idempotency_key` | `text` | yes | — |
| `status` | `varchar(16)` | yes | `'reserved'::character varying` |
| `reserved_cost_microunits` | `bigint` | yes | — |
| `actual_cost_microunits` | `bigint` | no | — |
| `input_tokens` | `bigint` | no | — |
| `output_tokens` | `bigint` | no | — |
| `error_code` | `text` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `finished_at` | `timestamptz` | no | — |
| `credit_grant_id` | `uuid` | no | — |

**Keys and constraints**

- `ai_request_credit_owner_fk`: `FOREIGN KEY (credit_grant_id, user_id) REFERENCES ai_credit_grants(id, user_id) ON DELETE RESTRICT`
- `ai_requests_actual_cost_microunits_check`: `CHECK ((actual_cost_microunits >= 0))`
- `ai_requests_budget_period_id_fkey`: `FOREIGN KEY (budget_period_id) REFERENCES ai_budget_periods(id) ON DELETE RESTRICT`
- `ai_requests_conversation_id_user_id_fkey`: `FOREIGN KEY (conversation_id, user_id) REFERENCES ai_conversations(id, user_id) ON DELETE RESTRICT`
- `ai_requests_id_user_id_key`: `UNIQUE (id, user_id)`
- `ai_requests_input_tokens_check`: `CHECK ((input_tokens >= 0))`
- `ai_requests_output_tokens_check`: `CHECK ((output_tokens >= 0))`
- `ai_requests_pkey`: `PRIMARY KEY (id)`
- `ai_requests_reserved_cost_microunits_check`: `CHECK ((reserved_cost_microunits >= 0))`
- `ai_requests_status_check`: `CHECK (((status)::text = ANY ((ARRAY['reserved'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'unknown'::character varying, 'cancelled'::character varying])::text[])))`
- `ai_requests_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `ai_requests_user_id_idempotency_key_key`: `UNIQUE (user_id, idempotency_key)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_requests_id_user_id_key ON public.ai_requests USING btree (id, user_id)`
- `CREATE UNIQUE INDEX ai_requests_pkey ON public.ai_requests USING btree (id)`
- `CREATE UNIQUE INDEX ai_requests_user_id_idempotency_key_key ON public.ai_requests USING btree (user_id, idempotency_key)`
- `CREATE INDEX fk_ai_requests_15_idx ON public.ai_requests USING btree (credit_grant_id, user_id)`
- `CREATE INDEX fk_ai_requests_16_idx ON public.ai_requests USING btree (budget_period_id)`
- `CREATE INDEX fk_ai_requests_17_idx ON public.ai_requests USING btree (conversation_id, user_id)`

**Referenced by**

- `ai_analyses(request_id)` → `ai_requests(id)`
- `ai_request_reservations(request_id)` → `ai_requests(id)`
- `ai_usage_ledger(request_id)` → `ai_requests(id)`

#### `ai_request_reservations`

Reservations linking one AI call to every applicable usage policy.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `request_id` | `uuid` | yes | — |
| `daily_usage_id` | `uuid` | yes | — |
| `reserved_requests` | `integer` | yes | `1` |
| `reserved_tokens` | `bigint` | yes | — |
| `reserved_cost_microunits` | `bigint` | yes | — |
| `settled_at` | `timestamptz` | no | — |

**Keys and constraints**

- `ai_request_reservations_daily_usage_id_fkey`: `FOREIGN KEY (daily_usage_id) REFERENCES ai_daily_usage(id) ON DELETE RESTRICT`
- `ai_request_reservations_pkey`: `PRIMARY KEY (request_id, daily_usage_id)`
- `ai_request_reservations_request_id_fkey`: `FOREIGN KEY (request_id) REFERENCES ai_requests(id) ON DELETE RESTRICT`
- `ai_request_reservations_reserved_cost_microunits_check`: `CHECK ((reserved_cost_microunits >= 0))`
- `ai_request_reservations_reserved_requests_check`: `CHECK ((reserved_requests >= 0))`
- `ai_request_reservations_reserved_tokens_check`: `CHECK ((reserved_tokens >= 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_request_reservations_pkey ON public.ai_request_reservations USING btree (request_id, daily_usage_id)`
- `CREATE INDEX fk_ai_request_reservations_14_idx ON public.ai_request_reservations USING btree (daily_usage_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `ai_usage_ledger`

Append-only reservation/settlement/release accounting events.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `request_id` | `uuid` | yes | — |
| `event_type` | `varchar(16)` | yes | — |
| `reserved_delta_microunits` | `bigint` | yes | `0` |
| `spent_delta_microunits` | `bigint` | yes | `0` |
| `idempotency_key` | `text` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `ai_usage_ledger_event_type_check`: `CHECK (((event_type)::text = ANY ((ARRAY['reserve'::character varying, 'settle'::character varying, 'release'::character varying, 'adjust'::character varying])::text[])))`
- `ai_usage_ledger_idempotency_key_key`: `UNIQUE (idempotency_key)`
- `ai_usage_ledger_pkey`: `PRIMARY KEY (id)`
- `ai_usage_ledger_request_id_fkey`: `FOREIGN KEY (request_id) REFERENCES ai_requests(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_usage_ledger_idempotency_key_key ON public.ai_usage_ledger USING btree (idempotency_key)`
- `CREATE UNIQUE INDEX ai_usage_ledger_pkey ON public.ai_usage_ledger USING btree (id)`
- `CREATE INDEX fk_ai_usage_ledger_18_idx ON public.ai_usage_ledger USING btree (request_id)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `ai_analyses`

Historical mistake analyses and recommendations tied to a paid request and optional attempt/course.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `course_id` | `uuid` | no | — |
| `attempt_id` | `uuid` | no | — |
| `request_id` | `uuid` | yes | — |
| `analysis_type` | `varchar(24)` | yes | — |
| `content` | `jsonb` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `ai_analyses_analysis_type_check`: `CHECK (((analysis_type)::text = ANY ((ARRAY['mistakes'::character varying, 'recommendations'::character varying, 'nct_progress'::character varying])::text[])))`
- `ai_analyses_attempt_id_fkey`: `FOREIGN KEY (attempt_id) REFERENCES test_attempts(id) ON DELETE RESTRICT`
- `ai_analyses_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `ai_analyses_pkey`: `PRIMARY KEY (id)`
- `ai_analyses_request_id_fkey`: `FOREIGN KEY (request_id) REFERENCES ai_requests(id) ON DELETE RESTRICT`
- `ai_analyses_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX ai_analyses_latest_idx ON public.ai_analyses USING btree (user_id, analysis_type, created_at)`
- `CREATE UNIQUE INDEX ai_analyses_pkey ON public.ai_analyses USING btree (id)`
- `CREATE INDEX fk_ai_analyses_2_idx ON public.ai_analyses USING btree (attempt_id)`
- `CREATE INDEX fk_ai_analyses_3_idx ON public.ai_analyses USING btree (course_id)`
- `CREATE INDEX fk_ai_analyses_4_idx ON public.ai_analyses USING btree (request_id)`

**Referenced by**

No incoming foreign keys in this baseline.

### I. Bonuses, AI credit packages and achievements — 8 tables


#### `bonus_accounts`

One bonus account per user; balance is derived from transactions.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `bonus_accounts_pkey`: `PRIMARY KEY (id)`
- `bonus_accounts_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `bonus_accounts_user_id_key`: `UNIQUE (user_id)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX bonus_accounts_pkey ON public.bonus_accounts USING btree (id)`
- `CREATE UNIQUE INDEX bonus_accounts_user_id_key ON public.bonus_accounts USING btree (user_id)`

**Referenced by**

- `bonus_transactions(account_id)` → `bonus_accounts(id)`

#### `bonus_rules`

Configurable reward conditions and amounts; no product values are seeded.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `event_type` | `varchar(32)` | yes | — |
| `points` | `bigint` | yes | — |
| `conditions` | `jsonb` | yes | `'{}'::jsonb` |
| `is_active` | `boolean` | yes | `true` |
| `created_by` | `uuid` | yes | — |

**Keys and constraints**

- `bonus_rules_code_key`: `UNIQUE (code)`
- `bonus_rules_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `bonus_rules_pkey`: `PRIMARY KEY (id)`
- `bonus_rules_points_check`: `CHECK ((points >= 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX bonus_rules_code_key ON public.bonus_rules USING btree (code)`
- `CREATE UNIQUE INDEX bonus_rules_pkey ON public.bonus_rules USING btree (id)`
- `CREATE INDEX fk_bonus_rules_28_idx ON public.bonus_rules USING btree (created_by)`

**Referenced by**

- `bonus_transactions(rule_id)` → `bonus_rules(id)`

#### `bonus_transactions`

Append-only signed bonus movements, event deduplication and compensating reversals.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `account_id` | `uuid` | yes | — |
| `delta` | `bigint` | yes | — |
| `rule_id` | `uuid` | no | — |
| `source_event_key` | `text` | yes | — |
| `operation` | `varchar(16)` | yes | — |
| `reverses_id` | `uuid` | no | — |
| `performed_by` | `uuid` | no | — |
| `reason` | `text` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `bonus_transactions_account_id_fkey`: `FOREIGN KEY (account_id) REFERENCES bonus_accounts(id) ON DELETE RESTRICT`
- `bonus_transactions_account_id_source_event_key_key`: `UNIQUE (account_id, source_event_key)`
- `bonus_transactions_check`: `CHECK (((reverses_id IS NULL) OR (reverses_id <> id)))`
- `bonus_transactions_delta_check`: `CHECK ((delta <> 0))`
- `bonus_transactions_operation_check`: `CHECK (((operation)::text = ANY ((ARRAY['earn'::character varying, 'spend'::character varying, 'refund'::character varying, 'adjust'::character varying])::text[])))`
- `bonus_transactions_performed_by_fkey`: `FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE RESTRICT`
- `bonus_transactions_pkey`: `PRIMARY KEY (id)`
- `bonus_transactions_reverses_id_fkey`: `FOREIGN KEY (reverses_id) REFERENCES bonus_transactions(id) ON DELETE RESTRICT`
- `bonus_transactions_rule_id_fkey`: `FOREIGN KEY (rule_id) REFERENCES bonus_rules(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX bonus_ledger_balance_idx ON public.bonus_transactions USING btree (account_id, created_at)`
- `CREATE UNIQUE INDEX bonus_transactions_account_id_source_event_key_key ON public.bonus_transactions USING btree (account_id, source_event_key)`
- `CREATE UNIQUE INDEX bonus_transactions_pkey ON public.bonus_transactions USING btree (id)`
- `CREATE INDEX fk_bonus_transactions_29_idx ON public.bonus_transactions USING btree (performed_by)`
- `CREATE INDEX fk_bonus_transactions_30_idx ON public.bonus_transactions USING btree (reverses_id)`
- `CREATE INDEX fk_bonus_transactions_31_idx ON public.bonus_transactions USING btree (rule_id)`

**Referenced by**

- `bonus_redemptions(transaction_id)` → `bonus_transactions(id)`
- `bonus_transactions(reverses_id)` → `bonus_transactions(id)`

#### `bonus_offers`

Exchange offers with prices and explicit package conditions.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `title` | `text` | yes | — |
| `price_points` | `bigint` | yes | — |
| `ai_requests_count` | `integer` | yes | — |
| `valid_days` | `integer` | no | — |
| `max_per_user_per_day` | `integer` | no | — |
| `is_active` | `boolean` | yes | `true` |
| `created_by` | `uuid` | yes | — |

**Keys and constraints**

- `bonus_offers_ai_requests_count_check`: `CHECK ((ai_requests_count > 0))`
- `bonus_offers_code_key`: `UNIQUE (code)`
- `bonus_offers_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `bonus_offers_max_per_user_per_day_check`: `CHECK ((max_per_user_per_day > 0))`
- `bonus_offers_pkey`: `PRIMARY KEY (id)`
- `bonus_offers_price_points_check`: `CHECK ((price_points > 0))`
- `bonus_offers_valid_days_check`: `CHECK ((valid_days > 0))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX bonus_offers_code_key ON public.bonus_offers USING btree (code)`
- `CREATE UNIQUE INDEX bonus_offers_pkey ON public.bonus_offers USING btree (id)`
- `CREATE INDEX fk_bonus_offers_26_idx ON public.bonus_offers USING btree (created_by)`

**Referenced by**

- `bonus_redemptions(offer_id)` → `bonus_offers(id)`

#### `bonus_redemptions`

An exchange event with snapshotted terms and linked debit transaction.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `offer_id` | `uuid` | yes | — |
| `transaction_id` | `uuid` | yes | — |
| `offer_snapshot` | `jsonb` | yes | — |
| `idempotency_key` | `text` | yes | — |
| `status` | `varchar(16)` | yes | `'completed'::character varying` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `bonus_redemptions_id_user_id_key`: `UNIQUE (id, user_id)`
- `bonus_redemptions_offer_id_fkey`: `FOREIGN KEY (offer_id) REFERENCES bonus_offers(id) ON DELETE RESTRICT`
- `bonus_redemptions_pkey`: `PRIMARY KEY (id)`
- `bonus_redemptions_status_check`: `CHECK (((status)::text = ANY ((ARRAY['completed'::character varying, 'reversed'::character varying])::text[])))`
- `bonus_redemptions_transaction_id_fkey`: `FOREIGN KEY (transaction_id) REFERENCES bonus_transactions(id) ON DELETE RESTRICT`
- `bonus_redemptions_transaction_id_key`: `UNIQUE (transaction_id)`
- `bonus_redemptions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `bonus_redemptions_user_id_idempotency_key_key`: `UNIQUE (user_id, idempotency_key)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX bonus_redemptions_id_user_id_key ON public.bonus_redemptions USING btree (id, user_id)`
- `CREATE UNIQUE INDEX bonus_redemptions_pkey ON public.bonus_redemptions USING btree (id)`
- `CREATE UNIQUE INDEX bonus_redemptions_transaction_id_key ON public.bonus_redemptions USING btree (transaction_id)`
- `CREATE UNIQUE INDEX bonus_redemptions_user_id_idempotency_key_key ON public.bonus_redemptions USING btree (user_id, idempotency_key)`
- `CREATE INDEX fk_bonus_redemptions_27_idx ON public.bonus_redemptions USING btree (offer_id)`

**Referenced by**

- `ai_credit_grants(redemption_id, user_id)` → `bonus_redemptions(id, user_id)`

#### `ai_credit_grants`

Issued AI request packages with usage and expiry, linked to a redemption and its owner.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `redemption_id` | `uuid` | yes | — |
| `total_requests` | `integer` | yes | — |
| `used_requests` | `integer` | yes | `0` |
| `reserved_requests` | `integer` | yes | `0` |
| `granted_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | no | — |
| `revoked_at` | `timestamptz` | no | — |

**Keys and constraints**

- `ai_credit_grants_check`: `CHECK (((used_requests + reserved_requests) <= total_requests))`
- `ai_credit_grants_check1`: `CHECK (((expires_at IS NULL) OR (expires_at > granted_at)))`
- `ai_credit_grants_id_user_id_key`: `UNIQUE (id, user_id)`
- `ai_credit_grants_pkey`: `PRIMARY KEY (id)`
- `ai_credit_grants_redemption_id_key`: `UNIQUE (redemption_id)`
- `ai_credit_grants_redemption_id_user_id_fkey`: `FOREIGN KEY (redemption_id, user_id) REFERENCES bonus_redemptions(id, user_id) ON DELETE RESTRICT`
- `ai_credit_grants_reserved_requests_check`: `CHECK ((reserved_requests >= 0))`
- `ai_credit_grants_total_requests_check`: `CHECK ((total_requests > 0))`
- `ai_credit_grants_used_requests_check`: `CHECK ((used_requests >= 0))`
- `ai_credit_grants_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX ai_credit_grants_id_user_id_key ON public.ai_credit_grants USING btree (id, user_id)`
- `CREATE UNIQUE INDEX ai_credit_grants_pkey ON public.ai_credit_grants USING btree (id)`
- `CREATE UNIQUE INDEX ai_credit_grants_redemption_id_key ON public.ai_credit_grants USING btree (redemption_id)`
- `CREATE INDEX fk_ai_credit_grants_7_idx ON public.ai_credit_grants USING btree (redemption_id, user_id)`
- `CREATE INDEX fk_ai_credit_grants_8_idx ON public.ai_credit_grants USING btree (user_id)`

**Referenced by**

- `ai_requests(credit_grant_id, user_id)` → `ai_credit_grants(id, user_id)`

#### `achievements`

Achievement definitions, criteria and optional icon.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `code` | `text` | yes | — |
| `title` | `text` | yes | — |
| `description` | `text` | no | — |
| `icon_asset_id` | `uuid` | no | — |
| `criteria` | `jsonb` | yes | — |
| `is_active` | `boolean` | yes | `true` |

**Keys and constraints**

- `achievements_code_key`: `UNIQUE (code)`
- `achievements_icon_asset_id_fkey`: `FOREIGN KEY (icon_asset_id) REFERENCES assets(id) ON DELETE RESTRICT`
- `achievements_pkey`: `PRIMARY KEY (id)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX achievements_code_key ON public.achievements USING btree (code)`
- `CREATE UNIQUE INDEX achievements_pkey ON public.achievements USING btree (id)`
- `CREATE INDEX fk_achievements_1_idx ON public.achievements USING btree (icon_asset_id)`

**Referenced by**

- `user_achievements(achievement_id)` → `achievements(id)`

#### `user_achievements`

Unique awarded achievements per learner, separate from spendable bonuses.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `user_id` | `uuid` | yes | — |
| `achievement_id` | `uuid` | yes | — |
| `awarded_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `source_event_key` | `text` | yes | — |

**Keys and constraints**

- `user_achievements_achievement_id_fkey`: `FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE RESTRICT`
- `user_achievements_pkey`: `PRIMARY KEY (user_id, achievement_id)`
- `user_achievements_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_user_achievements_98_idx ON public.user_achievements USING btree (achievement_id)`
- `CREATE UNIQUE INDEX user_achievements_pkey ON public.user_achievements USING btree (user_id, achievement_id)`

**Referenced by**

No incoming foreign keys in this baseline.

### J. Notifications — 6 tables


#### `telegram_connections`

Bot messaging connections and permission; separate from Telegram login identities.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `bot_id` | `text` | yes | — |
| `chat_id` | `bigint` | yes | — |
| `status` | `varchar(16)` | yes | `'active'::character varying` |
| `connected_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `blocked_at` | `timestamptz` | no | — |

**Keys and constraints**

- `telegram_connections_bot_id_chat_id_key`: `UNIQUE (bot_id, chat_id)`
- `telegram_connections_pkey`: `PRIMARY KEY (id)`
- `telegram_connections_status_check`: `CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'blocked'::character varying, 'disconnected'::character varying])::text[])))`
- `telegram_connections_user_id_bot_id_key`: `UNIQUE (user_id, bot_id)`
- `telegram_connections_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX telegram_connections_bot_id_chat_id_key ON public.telegram_connections USING btree (bot_id, chat_id)`
- `CREATE UNIQUE INDEX telegram_connections_pkey ON public.telegram_connections USING btree (id)`
- `CREATE UNIQUE INDEX telegram_connections_user_id_bot_id_key ON public.telegram_connections USING btree (user_id, bot_id)`

**Referenced by**

- `notification_deliveries(telegram_connection_id)` → `telegram_connections(id)`

#### `push_subscriptions`

Browser/device push endpoints and subscription state.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `endpoint` | `text` | yes | — |
| `p256dh` | `text` | yes | — |
| `auth_secret` | `text` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `revoked_at` | `timestamptz` | no | — |
| `last_success_at` | `timestamptz` | no | — |

**Keys and constraints**

- `push_subscriptions_endpoint_key`: `UNIQUE (endpoint)`
- `push_subscriptions_pkey`: `PRIMARY KEY (id)`
- `push_subscriptions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_push_subscriptions_68_idx ON public.push_subscriptions USING btree (user_id)`
- `CREATE UNIQUE INDEX push_subscriptions_endpoint_key ON public.push_subscriptions USING btree (endpoint)`
- `CREATE UNIQUE INDEX push_subscriptions_pkey ON public.push_subscriptions USING btree (id)`

**Referenced by**

- `notification_deliveries(push_subscription_id)` → `push_subscriptions(id)`

#### `notification_preferences`

Per-user channel/event preferences.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `user_id` | `uuid` | yes | — |
| `event_code` | `text` | yes | — |
| `channel` | `varchar(16)` | yes | — |
| `enabled` | `boolean` | yes | `true` |

**Keys and constraints**

- `notification_preferences_channel_check`: `CHECK (((channel)::text = ANY ((ARRAY['in_app'::character varying, 'push'::character varying, 'telegram'::character varying])::text[])))`
- `notification_preferences_pkey`: `PRIMARY KEY (user_id, event_code, channel)`
- `notification_preferences_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX notification_preferences_pkey ON public.notification_preferences USING btree (user_id, event_code, channel)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `broadcast_campaigns`

Scheduled campaigns with validated audience filter and templates.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `created_by` | `uuid` | yes | — |
| `title` | `text` | yes | — |
| `content` | `jsonb` | yes | — |
| `audience_filter` | `jsonb` | yes | — |
| `channels` | `jsonb` | yes | — |
| `timezone` | `varchar(64)` | yes | `'Asia/Dushanbe'::character varying` |
| `scheduled_at` | `timestamptz` | no | — |
| `status` | `varchar(16)` | yes | `'draft'::character varying` |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `finished_at` | `timestamptz` | no | — |

**Keys and constraints**

- `broadcast_campaigns_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT`
- `broadcast_campaigns_pkey`: `PRIMARY KEY (id)`
- `broadcast_campaigns_status_check`: `CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'scheduled'::character varying, 'sending'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'failed'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX broadcast_campaigns_pkey ON public.broadcast_campaigns USING btree (id)`
- `CREATE INDEX fk_broadcast_campaigns_32_idx ON public.broadcast_campaigns USING btree (created_by)`

**Referenced by**

- `notifications(campaign_id)` → `broadcast_campaigns(id)`

#### `notifications`

Materialized per-recipient in-app notifications and read state.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `campaign_id` | `uuid` | no | — |
| `event_code` | `text` | yes | — |
| `title` | `text` | yes | — |
| `body` | `text` | yes | — |
| `target_path` | `text` | no | — |
| `dedupe_key` | `text` | yes | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `read_at` | `timestamptz` | no | — |

**Keys and constraints**

- `notifications_campaign_id_fkey`: `FOREIGN KEY (campaign_id) REFERENCES broadcast_campaigns(id) ON DELETE RESTRICT`
- `notifications_pkey`: `PRIMARY KEY (id)`
- `notifications_user_id_dedupe_key_key`: `UNIQUE (user_id, dedupe_key)`
- `notifications_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_notifications_63_idx ON public.notifications USING btree (campaign_id)`
- `CREATE INDEX notifications_inbox_idx ON public.notifications USING btree (user_id, created_at)`
- `CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id)`
- `CREATE UNIQUE INDEX notifications_user_id_dedupe_key_key ON public.notifications USING btree (user_id, dedupe_key)`

**Referenced by**

- `notification_deliveries(notification_id)` → `notifications(id)`

#### `notification_deliveries`

Per-channel delivery state for a notification and a specific recipient endpoint.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `notification_id` | `uuid` | yes | — |
| `channel` | `varchar(16)` | yes | — |
| `push_subscription_id` | `uuid` | no | — |
| `telegram_connection_id` | `uuid` | no | — |
| `destination_key` | `text` | yes | — |
| `provider_message_id` | `text` | no | — |
| `status` | `varchar(16)` | yes | `'pending'::character varying` |
| `attempt_count` | `integer` | yes | `0` |
| `next_attempt_at` | `timestamptz` | no | — |
| `last_error_code` | `text` | no | — |
| `sent_at` | `timestamptz` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `notification_deliveries_attempt_count_check`: `CHECK ((attempt_count >= 0))`
- `notification_deliveries_channel_check`: `CHECK (((channel)::text = ANY ((ARRAY['push'::character varying, 'telegram'::character varying])::text[])))`
- `notification_deliveries_check`: `CHECK (((((channel)::text = 'push'::text) AND (push_subscription_id IS NOT NULL) AND (telegram_connection_id IS NULL)) OR (((channel)::text = 'telegram'::text) AND (telegram_connection_id IS NOT NULL) AND (push_subscription_id IS NULL))))`
- `notification_deliveries_notification_id_channel_destination_key`: `UNIQUE (notification_id, channel, destination_key)`
- `notification_deliveries_notification_id_fkey`: `FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE RESTRICT`
- `notification_deliveries_pkey`: `PRIMARY KEY (id)`
- `notification_deliveries_push_subscription_id_fkey`: `FOREIGN KEY (push_subscription_id) REFERENCES push_subscriptions(id) ON DELETE RESTRICT`
- `notification_deliveries_status_check`: `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sending'::character varying, 'sent'::character varying, 'failed'::character varying, 'unknown'::character varying, 'cancelled'::character varying])::text[])))`
- `notification_deliveries_telegram_connection_id_fkey`: `FOREIGN KEY (telegram_connection_id) REFERENCES telegram_connections(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX delivery_pending_idx ON public.notification_deliveries USING btree (next_attempt_at) WHERE ((status)::text = 'pending'::text)`
- `CREATE INDEX fk_notification_deliveries_61_idx ON public.notification_deliveries USING btree (push_subscription_id)`
- `CREATE INDEX fk_notification_deliveries_62_idx ON public.notification_deliveries USING btree (telegram_connection_id)`
- `CREATE UNIQUE INDEX notification_deliveries_notification_id_channel_destination_key ON public.notification_deliveries USING btree (notification_id, channel, destination_key)`
- `CREATE UNIQUE INDEX notification_deliveries_pkey ON public.notification_deliveries USING btree (id)`

**Referenced by**

No incoming foreign keys in this baseline.

### K. Operations — 4 tables


#### `learning_activity_events`

Learning activity facts supporting streaks and analytics, without one event per video second.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `lesson_id` | `uuid` | no | — |
| `attempt_id` | `uuid` | no | — |
| `event_code` | `text` | yes | — |
| `source_event_key` | `text` | yes | — |
| `occurred_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `metadata` | `jsonb` | yes | `'{}'::jsonb` |

**Keys and constraints**

- `learning_activity_events_attempt_id_fkey`: `FOREIGN KEY (attempt_id) REFERENCES test_attempts(id) ON DELETE RESTRICT`
- `learning_activity_events_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE RESTRICT`
- `learning_activity_events_pkey`: `PRIMARY KEY (id)`
- `learning_activity_events_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `learning_activity_events_user_id_source_event_key_key`: `UNIQUE (user_id, source_event_key)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_learning_activity_events_48_idx ON public.learning_activity_events USING btree (attempt_id)`
- `CREATE INDEX fk_learning_activity_events_49_idx ON public.learning_activity_events USING btree (lesson_id)`
- `CREATE UNIQUE INDEX learning_activity_events_pkey ON public.learning_activity_events USING btree (id)`
- `CREATE UNIQUE INDEX learning_activity_events_user_id_source_event_key_key ON public.learning_activity_events USING btree (user_id, source_event_key)`
- `CREATE INDEX learning_activity_user_idx ON public.learning_activity_events USING btree (user_id, occurred_at)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `background_jobs`

Persistent work queue with states, attempts and leases for multiple workers.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `job_type` | `text` | yes | — |
| `payload` | `jsonb` | yes | `'{}'::jsonb` |
| `dedupe_key` | `text` | yes | — |
| `status` | `varchar(16)` | yes | `'pending'::character varying` |
| `available_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `locked_by` | `text` | no | — |
| `lease_expires_at` | `timestamptz` | no | — |
| `attempts` | `integer` | yes | `0` |
| `max_attempts` | `integer` | yes | `5` |
| `last_error_code` | `text` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `finished_at` | `timestamptz` | no | — |

**Keys and constraints**

- `background_jobs_attempts_check`: `CHECK ((attempts >= 0))`
- `background_jobs_dedupe_key_key`: `UNIQUE (dedupe_key)`
- `background_jobs_max_attempts_check`: `CHECK ((max_attempts > 0))`
- `background_jobs_pkey`: `PRIMARY KEY (id)`
- `background_jobs_status_check`: `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE UNIQUE INDEX background_jobs_dedupe_key_key ON public.background_jobs USING btree (dedupe_key)`
- `CREATE UNIQUE INDEX background_jobs_pkey ON public.background_jobs USING btree (id)`
- `CREATE INDEX jobs_claim_idx ON public.background_jobs USING btree (available_at, created_at) WHERE ((status)::text = 'pending'::text)`
- `CREATE INDEX jobs_lease_idx ON public.background_jobs USING btree (lease_expires_at) WHERE ((status)::text = 'running'::text)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `idempotency_keys`

Request deduplication scoped to actor and operation, with a request hash and safe response data.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `id` | `uuid` | yes | — |
| `user_id` | `uuid` | yes | — |
| `operation` | `text` | yes | — |
| `idempotency_key` | `text` | yes | — |
| `request_hash` | `text` | yes | — |
| `status` | `varchar(16)` | yes | `'running'::character varying` |
| `response_code` | `integer` | no | — |
| `response_body` | `jsonb` | no | — |
| `created_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |
| `expires_at` | `timestamptz` | yes | — |

**Keys and constraints**

- `idempotency_keys_check`: `CHECK ((expires_at > created_at))`
- `idempotency_keys_pkey`: `PRIMARY KEY (id)`
- `idempotency_keys_status_check`: `CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))`
- `idempotency_keys_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
- `idempotency_keys_user_id_operation_idempotency_key_key`: `UNIQUE (user_id, operation, idempotency_key)`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX idempotency_expiry_idx ON public.idempotency_keys USING btree (expires_at)`
- `CREATE UNIQUE INDEX idempotency_keys_pkey ON public.idempotency_keys USING btree (id)`
- `CREATE UNIQUE INDEX idempotency_keys_user_id_operation_idempotency_key_key ON public.idempotency_keys USING btree (user_id, operation, idempotency_key)`

**Referenced by**

No incoming foreign keys in this baseline.

#### `platform_settings`

Validated non-secret platform configuration, including manual maintenance state.

| Column | PostgreSQL type | Required | Default |
|---|---|---|---|
| `key` | `text` | yes | — |
| `value` | `jsonb` | yes | — |
| `updated_by` | `uuid` | no | — |
| `updated_at` | `timestamptz` | yes | `CURRENT_TIMESTAMP` |

**Keys and constraints**

- `platform_settings_pkey`: `PRIMARY KEY (key)`
- `platform_settings_updated_by_fkey`: `FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT`

**Indexes** (constraint-backed indexes are included; do not create them a second time)

- `CREATE INDEX fk_platform_settings_67_idx ON public.platform_settings USING btree (updated_by)`
- `CREATE UNIQUE INDEX platform_settings_pkey ON public.platform_settings USING btree (key)`

**Referenced by**

No incoming foreign keys in this baseline.

## 7. Functions, triggers, seeds and complete baseline SQL

The following single SQL block is the complete original `everest_full_v0_2.sql`, preserved byte-for-byte between the fence lines, including original source comments. Its SHA-256 is `a57da9d466e7b3451f7bb9e24908bd3f42fc636a9261acb553fbfbcbe6a1ef80`. The earlier dictionary includes the final effects of all ALTER statements in this block.

This block is reference DDL for migration authoring. Do not execute it alongside migrations that already create these objects. Do not replace the function/trigger bodies with stubs. Preserve all seven functions and eleven triggers, including:

- can_access_module: effective learning grant predicate, not complete API authorization.
- assert_question_draft, guard_question_child and guard_question: published/archived question integrity and publication prerequisites.
- guard_test_question and guard_test: test composition and publication integrity.
- forbid_ledger_rewrite: append-only protections for bonus_transactions, ai_usage_ledger and attempt_score_revisions.

There are no automatic updated_at triggers, RLS policies, provider integrations or implicit administrator permission checks in this DDL. The four role seed rows are the only initial data; do not seed fake users, questions, entitlements, tariffs, AI budgets or provider secrets. Runtime DB credentials must have only the privileges needed by the application, separate from the migration owner.

```sql
-- EVEREST — полный проект PostgreSQL v0.2 / 24.10.2026.
-- Единый baseline для НОВОЙ тестовой БД, НЕ дополнение к auth_v0_1.sql.
-- Содержит фундамент и будущие расширения. Внедрять по этапам.
-- UUID задаёт backend; даты TIMESTAMPTZ; updated_at обновляет backend.
-- Окончательные продуктовые правила см. everest_architecture_v0_2.md.
-- Не содержит EduCRM, WebRTC, tenant_id, group_courses, question_versions.
-- Все FK по умолчанию RESTRICT, чтобы не уничтожать учебную историю.
-- Импортёры диаграмм могут пропускать CHECK, функции и триггеры.

CREATE TABLE users (
    id UUID PRIMARY KEY,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    onboarding_completed_at TIMESTAMPTZ,
    approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    approved_at TIMESTAMPTZ,
    blocked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    blocked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ,
    CONSTRAINT users_status_check CHECK (status IN ('pending','active','blocked','rejected')),
    CONSTRAINT users_blocked_check CHECK (status <> 'blocked' OR blocked_at IS NOT NULL),
    CONSTRAINT users_approval_actor_check CHECK (approved_by IS NULL OR approved_at IS NOT NULL)
);

CREATE TABLE user_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    language_code VARCHAR(2) NOT NULL DEFAULT 'ru',
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dushanbe',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT profiles_language_check CHECK (language_code IN ('tg','ru','en')),
    CONSTRAINT profiles_first_name_check CHECK (first_name IS NULL OR length(trim(first_name)) > 0),
    CONSTRAINT profiles_last_name_check CHECK (last_name IS NULL OR length(trim(last_name)) > 0)
);

CREATE TABLE user_phones (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    phone_e164 VARCHAR(16) NOT NULL UNIQUE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    verification_method VARCHAR(24),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT phones_id_user_unique UNIQUE (id, user_id),
    CONSTRAINT phones_e164_check CHECK (phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),
    CONSTRAINT phones_verification_check CHECK (
        (verified_at IS NULL AND verification_method IS NULL) OR
        (verified_at IS NOT NULL AND verification_method IS NOT NULL AND
         verification_method IN ('sms','telegram_verified','admin_verified'))
    ),
    CONSTRAINT phones_primary_verified_check CHECK (NOT is_primary OR verified_at IS NOT NULL)
);

CREATE TABLE user_passwords (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    password_hash TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT passwords_hash_check CHECK (length(password_hash) > 0)
);

CREATE TABLE auth_identities (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider VARCHAR(24) NOT NULL,
    issuer TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    provider_profile JSONB NOT NULL DEFAULT '{}',
    linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ,
    CONSTRAINT identities_subject_unique UNIQUE (provider, issuer, provider_subject),
    CONSTRAINT identities_user_provider_unique UNIQUE (user_id, provider, issuer),
    CONSTRAINT identities_provider_check CHECK (provider = 'telegram'),
    CONSTRAINT identities_nonempty_check CHECK (length(issuer) > 0 AND length(provider_subject) > 0),
    CONSTRAINT identities_profile_check CHECK (jsonb_typeof(provider_profile) = 'object')
);

CREATE TABLE roles (
    id UUID PRIMARY KEY,
    code VARCHAR(24) NOT NULL UNIQUE,
    CONSTRAINT roles_code_check CHECK (code IN ('owner','admin','teacher','student'))
);

CREATE TABLE user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    assigned_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoke_reason VARCHAR(40),
    user_agent TEXT,
    ip_address INET,
    CONSTRAINT sessions_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT sessions_revoke_check CHECK (revoke_reason IS NULL OR revoked_at IS NOT NULL)
);

CREATE TABLE auth_refresh_tokens (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT refresh_hash_check CHECK (length(token_hash) > 0),
    CONSTRAINT refresh_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE auth_challenges (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    user_phone_id UUID,
    purpose VARCHAR(32) NOT NULL,
    channel VARCHAR(16) NOT NULL DEFAULT 'sms',
    target_phone_e164 VARCHAR(16) NOT NULL,
    secret_hash TEXT NOT NULL,
    attempts_count SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    CONSTRAINT challenges_phone_owner_fk FOREIGN KEY (user_phone_id, user_id)
        REFERENCES user_phones(id, user_id) ON DELETE RESTRICT,
    CONSTRAINT challenges_purpose_check CHECK (purpose IN ('register_phone','verify_phone','reset_password','change_phone')),
    CONSTRAINT challenges_channel_check CHECK (channel = 'sms'),
    CONSTRAINT challenges_phone_check CHECK (target_phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),
    CONSTRAINT challenges_owner_check CHECK (user_phone_id IS NULL OR user_id IS NOT NULL),
    CONSTRAINT challenges_reset_binding_check CHECK (
        purpose <> 'reset_password' OR (user_id IS NOT NULL AND user_phone_id IS NOT NULL)
    ),
    CONSTRAINT challenges_secret_check CHECK (length(secret_hash) > 0),
    CONSTRAINT challenges_attempts_check CHECK (max_attempts > 0 AND attempts_count BETWEEN 0 AND max_attempts),
    CONSTRAINT challenges_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE sms_deliveries (
    id UUID PRIMARY KEY,
    challenge_id UUID NOT NULL REFERENCES auth_challenges(id) ON DELETE RESTRICT,
    provider_code VARCHAR(40) NOT NULL,
    provider_message_id TEXT,
    idempotency_key UUID NOT NULL UNIQUE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    error_code VARCHAR(80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    CONSTRAINT sms_status_check CHECK (status IN ('pending','sent','delivered','failed','unknown')),
    CONSTRAINT sms_provider_message_unique UNIQUE (provider_code, provider_message_id)
);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY,
    actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    subject_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    event_code VARCHAR(80) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT audit_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX users_approved_by_idx ON users(approved_by);
CREATE INDEX users_blocked_by_idx ON users(blocked_by);
CREATE INDEX users_status_created_idx ON users(status, created_at);
CREATE UNIQUE INDEX user_phones_one_primary_idx ON user_phones(user_id) WHERE is_primary;
CREATE INDEX user_phones_user_idx ON user_phones(user_id);
CREATE INDEX user_roles_role_idx ON user_roles(role_id);
CREATE INDEX user_roles_assigned_by_idx ON user_roles(assigned_by);
CREATE INDEX sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX sessions_expiry_idx ON auth_sessions(expires_at);
CREATE INDEX refresh_session_idx ON auth_refresh_tokens(session_id);
CREATE INDEX challenges_user_idx ON auth_challenges(user_id);
CREATE INDEX challenges_phone_owner_idx ON auth_challenges(user_phone_id, user_id);
CREATE INDEX challenges_target_created_idx ON auth_challenges(target_phone_e164, purpose, created_at);
CREATE INDEX challenges_expiry_idx ON auth_challenges(expires_at);
CREATE INDEX sms_challenge_idx ON sms_deliveries(challenge_id);
CREATE INDEX audit_actor_idx ON audit_events(actor_user_id, created_at);
CREATE INDEX audit_subject_idx ON audit_events(subject_user_id, created_at);


-- A Авторизация: Приглашения без автоматического повышения роли
CREATE TABLE user_invitations (
id UUID PRIMARY KEY,
invited_phone_e164 VARCHAR(16), token_hash TEXT NOT NULL UNIQUE,
invited_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
accepted_by UUID REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
CHECK (expires_at > created_at), CHECK (accepted_at IS NULL OR accepted_by IS NOT NULL),
CHECK (invited_phone_e164 IS NULL OR invited_phone_e164 ~ '^\+[1-9][0-9]{1,14}$')
);

-- B Файлы: Метаданные файлов; сами байты вне PostgreSQL
CREATE TABLE assets (
id UUID PRIMARY KEY,
storage_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, file_name TEXT,
size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0), sha256 VARCHAR(64),
width_px INTEGER CHECK (width_px > 0), height_px INTEGER CHECK (height_px > 0),
duration_seconds INTEGER CHECK (duration_seconds >= 0),
status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','quarantined','archived')),
uploaded_by UUID REFERENCES users(id) ON DELETE RESTRICT, source_metadata JSONB NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$')
);

-- B Файлы: Внешние ID разных импортов могут ссылаться на один файл
CREATE TABLE asset_aliases (
id UUID PRIMARY KEY,
source_namespace TEXT NOT NULL, external_id TEXT NOT NULL,
asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT, UNIQUE (source_namespace, external_id)
);
ALTER TABLE user_profiles ADD COLUMN avatar_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT;

-- C Группы: Учебные сообщества, не выдающие доступ к курсам
CREATE TABLE groups (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- C Группы: Текущий состав; историю смены статуса хранит аудит
CREATE TABLE group_members (
id UUID PRIMARY KEY,
group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','removed')),
is_representative BOOLEAN NOT NULL DEFAULT FALSE,
joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, left_at TIMESTAMPTZ,
added_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, UNIQUE (group_id,user_id)
);

-- C Группы: Преподаватели и индивидуальные полномочия в группе
CREATE TABLE group_teachers (
id UUID PRIMARY KEY,
group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
can_publish_announcements BOOLEAN NOT NULL DEFAULT FALSE,
can_assign_tests BOOLEAN NOT NULL DEFAULT FALSE, can_view_results BOOLEAN NOT NULL DEFAULT FALSE,
assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (group_id,user_id)
);

-- C Группы: Объявления администратора или преподавателя
CREATE TABLE group_announcements (
id UUID PRIMARY KEY,
group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
title TEXT NOT NULL, content JSONB NOT NULL DEFAULT '{"blocks":[]}',
is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- C Группы: Вложения объявлений
CREATE TABLE announcement_assets (
announcement_id UUID NOT NULL REFERENCES group_announcements(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
PRIMARY KEY (announcement_id,asset_id)
);

-- D Справочники: Предметы
CREATE TABLE subjects (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, primary_language VARCHAR(2) NOT NULL DEFAULT 'tg',
CHECK (primary_language IN ('tg','ru','en'))
);

-- D Справочники: Необязательные переводы названия предмета
CREATE TABLE subject_translations (
subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, language_code VARCHAR(2) NOT NULL,
title TEXT NOT NULL, PRIMARY KEY (subject_id,language_code), CHECK (language_code IN ('tg','ru','en'))
);

-- D Справочники: Разделы предметов
CREATE TABLE sections (
id UUID PRIMARY KEY,
subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, code TEXT NOT NULL,
primary_language VARCHAR(2) NOT NULL DEFAULT 'tg', UNIQUE (subject_id,code), UNIQUE (id,subject_id),
CHECK (primary_language IN ('tg','ru','en'))
);

-- D Справочники: Необязательные переводы разделов
CREATE TABLE section_translations (
section_id UUID NOT NULL REFERENCES sections(id) ON DELETE RESTRICT, language_code VARCHAR(2) NOT NULL,
title TEXT NOT NULL, PRIMARY KEY (section_id,language_code), CHECK (language_code IN ('tg','ru','en'))
);

-- D Справочники: Темы и подтемы с проверкой принадлежности предмету
CREATE TABLE topics (
id UUID PRIMARY KEY,
subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, section_id UUID, parent_id UUID,
code TEXT NOT NULL, primary_language VARCHAR(2) NOT NULL DEFAULT 'tg',
UNIQUE (subject_id,code), UNIQUE (id,subject_id), CHECK (parent_id IS NULL OR parent_id <> id),
CHECK (primary_language IN ('tg','ru','en')),
FOREIGN KEY (section_id,subject_id) REFERENCES sections(id,subject_id) ON DELETE RESTRICT,
FOREIGN KEY (parent_id,subject_id) REFERENCES topics(id,subject_id) ON DELETE RESTRICT
);

-- D Справочники: Необязательные переводы тем
CREATE TABLE topic_translations (
topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE RESTRICT, language_code VARCHAR(2) NOT NULL,
title TEXT NOT NULL, PRIMARY KEY (topic_id,language_code), CHECK (language_code IN ('tg','ru','en'))
);

-- E Обучение: Курсы; не связаны с группами
CREATE TABLE courses (
id UUID PRIMARY KEY,
subject_id UUID REFERENCES subjects(id) ON DELETE RESTRICT, title TEXT NOT NULL, description TEXT,
language_code VARCHAR(2) NOT NULL DEFAULT 'ru' CHECK (language_code IN ('tg','ru','en')),
translations JSONB NOT NULL DEFAULT '{}', cover_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- E Обучение: Права преподавателя на конкретный курс
CREATE TABLE course_teachers (
id UUID PRIMARY KEY,
course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
can_manage_lessons BOOLEAN NOT NULL DEFAULT FALSE, can_manage_questions BOOLEAN NOT NULL DEFAULT FALSE,
can_manage_tests BOOLEAN NOT NULL DEFAULT FALSE, can_view_results BOOLEAN NOT NULL DEFAULT FALSE,
assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, UNIQUE (course_id,user_id)
);

-- E Обучение: Администратор вручную выдаёт доступ человеку к курсу
CREATE TABLE course_enrollments (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
granted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
begins_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ,
revoked_at TIMESTAMPTZ, revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
UNIQUE (user_id,course_id), CHECK (expires_at IS NULL OR expires_at > begins_at),
CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

-- E Обучение: Модули и публичные метаданные закрытых модулей
CREATE TABLE course_modules (
id UUID PRIMARY KEY,
course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT, title TEXT NOT NULL, description TEXT,
position INTEGER NOT NULL CHECK (position > 0), translations JSONB NOT NULL DEFAULT '{}',
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (course_id,position), UNIQUE (id,course_id)
);

-- E Обучение: Отдельный доступ к модулю; курс должен быть назначен
CREATE TABLE module_access_grants (
id UUID PRIMARY KEY,
user_id UUID NOT NULL, course_id UUID NOT NULL, module_id UUID NOT NULL,
granted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
begins_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ,
revoked_at TIMESTAMPTZ, revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT, UNIQUE (user_id,module_id),
FOREIGN KEY (user_id,course_id) REFERENCES course_enrollments(user_id,course_id) ON DELETE RESTRICT,
FOREIGN KEY (module_id,course_id) REFERENCES course_modules(id,course_id) ON DELETE RESTRICT,
CHECK (expires_at IS NULL OR expires_at > begins_at), CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

-- E Обучение: Уроки внутри модуля
CREATE TABLE lessons (
id UUID PRIMARY KEY,
module_id UUID NOT NULL, course_id UUID NOT NULL,
title TEXT NOT NULL, position INTEGER NOT NULL CHECK (position > 0),
lesson_type VARCHAR(16) NOT NULL CHECK (lesson_type IN ('video','text','test','mixed')),
content JSONB NOT NULL DEFAULT '{"blocks":[]}', translations JSONB NOT NULL DEFAULT '{}',
video_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT, allow_offline BOOLEAN NOT NULL DEFAULT FALSE,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (module_id,position), UNIQUE (id,course_id),
FOREIGN KEY (module_id,course_id) REFERENCES course_modules(id,course_id) ON DELETE RESTRICT
);

-- E Обучение: Дополнительные материалы урока
CREATE TABLE lesson_resources (
id UUID PRIMARY KEY,
lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
title TEXT, position INTEGER NOT NULL DEFAULT 1 CHECK (position > 0), UNIQUE (lesson_id,asset_id)
);

-- E Обучение: Текущий прогресс; не каждую секунду отдельной строкой
CREATE TABLE lesson_progress (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','completed')),
playback_seconds INTEGER NOT NULL DEFAULT 0 CHECK (playback_seconds >= 0),
watched_seconds INTEGER NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0), PRIMARY KEY (user_id,lesson_id),
CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

-- E Обучение: Личные заметки, видимые только владельцу
CREATE TABLE lesson_notes (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
body TEXT NOT NULL, playback_seconds INTEGER CHECK (playback_seconds >= 0),
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- E Обучение: Избранные курсы
CREATE TABLE course_favorites (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id,course_id)
);

-- E Обучение: Разрешения и учёт офлайн-загрузок; не DRM
CREATE TABLE offline_downloads (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, lease_expires_at TIMESTAMPTZ NOT NULL,
last_checked_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, UNIQUE (session_id,lesson_id,asset_id),
CHECK (lease_expires_at > granted_at)
);

-- F Вопросы: Банки книг/преподавателей
CREATE TABLE question_banks (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, visibility VARCHAR(16) NOT NULL DEFAULT 'private'
CHECK (visibility IN ('private','staff')), source_metadata JSONB NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (id,subject_id)
);

-- F Вопросы: Пакетный импорт и dry-run
CREATE TABLE question_imports (
id UUID PRIMARY KEY,
bank_id UUID NOT NULL REFERENCES question_banks(id) ON DELETE RESTRICT, initiated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
package_sha256 VARCHAR(64) NOT NULL, schema_version TEXT NOT NULL,
idempotency_key TEXT NOT NULL, is_dry_run BOOLEAN NOT NULL DEFAULT TRUE,
status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validating','validated','importing','completed','failed')),
manifest JSONB NOT NULL, counters JSONB NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ,
UNIQUE (bank_id,idempotency_key)
);

-- F Вопросы: Проверяемый отчёт ошибок импорта
CREATE TABLE question_import_errors (
id UUID PRIMARY KEY,
import_id UUID NOT NULL REFERENCES question_imports(id) ON DELETE RESTRICT, external_id TEXT, record_path TEXT,
severity VARCHAR(16) NOT NULL CHECK (severity IN ('warning','error')),
error_code TEXT NOT NULL, message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- F Вопросы: Содержимое вопроса; изменения опубликованного — через копию
CREATE TABLE questions (
id UUID PRIMARY KEY,
bank_id UUID NOT NULL, subject_id UUID NOT NULL, external_id TEXT,
question_type VARCHAR(24) NOT NULL CHECK (question_type IN ('single_choice','multiple_choice','matching','numeric','short_text')),
language_code VARCHAR(2) NOT NULL CHECK (language_code IN ('tg','ru','en')),
difficulty SMALLINT CHECK (difficulty BETWEEN 1 AND 5),
difficulty_source VARCHAR(16) CHECK (difficulty_source IN ('ai','expert','official')),
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
content JSONB NOT NULL DEFAULT '{"blocks":[]}', interaction_settings JSONB NOT NULL DEFAULT '{}',
source_metadata JSONB NOT NULL DEFAULT '{}', source_question_id UUID REFERENCES questions(id) ON DELETE RESTRICT,
import_id UUID REFERENCES question_imports(id) ON DELETE RESTRICT, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (bank_id,external_id), UNIQUE (id,subject_id), FOREIGN KEY (bank_id,subject_id) REFERENCES question_banks(id,subject_id) ON DELETE RESTRICT,
CHECK (jsonb_typeof(content) = 'object'), CHECK (jsonb_typeof(interaction_settings) = 'object'),
CHECK ((difficulty IS NULL) = (difficulty_source IS NULL)), CHECK (source_question_id IS NULL OR source_question_id <> id)
);

-- F Вопросы: Варианты БЕЗ is_correct
CREATE TABLE question_options (
id UUID PRIMARY KEY,
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, option_key TEXT NOT NULL,
position INTEGER NOT NULL CHECK (position > 0), source_label TEXT,
content JSONB NOT NULL DEFAULT '{"blocks":[]}', UNIQUE (question_id,option_key), UNIQUE (question_id,position),
UNIQUE (id,question_id)
);

-- F Вопросы: Элементы левой и правой стороны
CREATE TABLE question_matching_items (
id UUID PRIMARY KEY,
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, side VARCHAR(5) NOT NULL CHECK (side IN ('left','right')),
item_key TEXT NOT NULL, position INTEGER NOT NULL CHECK (position > 0), source_label TEXT,
content JSONB NOT NULL DEFAULT '{"blocks":[]}', UNIQUE (question_id,side,item_key),
UNIQUE (question_id,side,position), UNIQUE (id,question_id)
);

-- F Вопросы: Единственный авторский источник правильного ответа
CREATE TABLE question_answer_keys (
question_id UUID PRIMARY KEY REFERENCES questions(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','proposed','verified')),
source VARCHAR(24) NOT NULL DEFAULT 'none' CHECK (source IN ('none','official_key','expert_review','ai_inference')),
answer_data JSONB, explanation JSONB NOT NULL DEFAULT '{"blocks":[]}',
verified_by UUID REFERENCES users(id) ON DELETE RESTRICT, verified_at TIMESTAMPTZ,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
CHECK (answer_data IS NULL OR jsonb_typeof(answer_data) = 'object'),
CHECK (status = 'unknown' OR answer_data IS NOT NULL),
CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND source <> 'none'))
);

-- F Вопросы: Темы вопроса должны принадлежать тому же предмету
CREATE TABLE question_topics (
question_id UUID NOT NULL, topic_id UUID NOT NULL, subject_id UUID NOT NULL,
PRIMARY KEY (question_id,topic_id), FOREIGN KEY (question_id,subject_id) REFERENCES questions(id,subject_id) ON DELETE RESTRICT,
FOREIGN KEY (topic_id,subject_id) REFERENCES topics(id,subject_id) ON DELETE RESTRICT
);

-- F Вопросы: Файлы, используемые в вопросе/вариантах/объяснении
CREATE TABLE question_assets (
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
PRIMARY KEY (question_id,asset_id)
);

-- F Вопросы: Дубликаты сохраняют ID; генератор исключает повторы
CREATE TABLE question_duplicate_links (
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, duplicate_of_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
reason TEXT, marked_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, PRIMARY KEY (question_id,duplicate_of_id),
CHECK (question_id <> duplicate_of_id)
);

-- G Тестирование: Фиксированный вариант теста; правки опубликованного через копию
CREATE TABLE tests (
id UUID PRIMARY KEY,
title TEXT NOT NULL, mode VARCHAR(16) NOT NULL CHECK (mode IN ('lesson','practice','exam','nct')),
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
duration_seconds INTEGER CHECK (duration_seconds > 0),
max_attempts INTEGER CHECK (max_attempts > 0), result_policy VARCHAR(16) NOT NULL DEFAULT 'first'
CHECK (result_policy IN ('first','best','last')),
answer_reveal_policy VARCHAR(24) NOT NULL DEFAULT 'after_submission'
CHECK (answer_reveal_policy IN ('after_answer','after_submission','after_window','never')),
shuffle_questions BOOLEAN NOT NULL DEFAULT FALSE, shuffle_options BOOLEAN NOT NULL DEFAULT FALSE,
grading_policy JSONB NOT NULL DEFAULT '{}', generation_filters JSONB NOT NULL DEFAULT '{}',
copied_from_id UUID REFERENCES tests(id) ON DELETE RESTRICT, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
CHECK (mode NOT IN ('exam','nct') OR duration_seconds IS NOT NULL),
CHECK (mode NOT IN ('exam','nct') OR answer_reveal_policy <> 'after_answer')
);

-- G Тестирование: Зафиксированные вопросы теста и максимальные баллы
CREATE TABLE test_questions (
id UUID PRIMARY KEY,
test_id UUID NOT NULL REFERENCES tests(id) ON DELETE RESTRICT, question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
position INTEGER NOT NULL CHECK (position > 0), points NUMERIC(10,2) NOT NULL CHECK (points > 0),
UNIQUE (test_id,question_id), UNIQUE (test_id,position), UNIQUE (id,test_id,question_id)
);

-- G Тестирование: Одно назначение — одна аудитория; курс, урок, группа или ученик
CREATE TABLE test_assignments (
id UUID PRIMARY KEY,
test_id UUID NOT NULL REFERENCES tests(id) ON DELETE RESTRICT, course_id UUID REFERENCES courses(id) ON DELETE RESTRICT,
lesson_id UUID REFERENCES lessons(id) ON DELETE RESTRICT, group_id UUID REFERENCES groups(id) ON DELETE RESTRICT, user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','closed')),
opens_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, closes_at TIMESTAMPTZ,
counts_for_group_ranking BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (id,test_id),
CHECK (num_nonnulls(course_id,lesson_id,group_id,user_id) = 1),
CHECK (closes_at IS NULL OR closes_at > opens_at),
CHECK (NOT counts_for_group_ranking OR group_id IS NOT NULL)
);

-- G Тестирование: Попытки и серверный таймер; номер считается в рамках назначения
CREATE TABLE test_attempts (
id UUID PRIMARY KEY,
test_id UUID NOT NULL REFERENCES tests(id) ON DELETE RESTRICT, assignment_id UUID NOT NULL,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
status VARCHAR(16) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','paused','submitted','expired','graded','cancelled')),
started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ,
paused_at TIMESTAMPTZ, paused_seconds INTEGER NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0),
submitted_at TIMESTAMPTZ, graded_at TIMESTAMPTZ,
score NUMERIC(12,2) CHECK (score >= 0), max_score NUMERIC(12,2) CHECK (max_score > 0),
policy_snapshot JSONB NOT NULL, UNIQUE (assignment_id,user_id,attempt_number), UNIQUE (id,test_id),
FOREIGN KEY (assignment_id,test_id) REFERENCES test_assignments(id,test_id) ON DELETE RESTRICT,
CHECK (expires_at IS NULL OR expires_at > started_at), CHECK (score IS NULL OR max_score IS NULL OR score <= max_score),
CHECK (status <> 'paused' OR paused_at IS NOT NULL),
CHECK (status <> 'graded' OR (score IS NOT NULL AND max_score IS NOT NULL AND graded_at IS NOT NULL))
);

-- G Тестирование: Порядок и служебный снимок условий оценивания конкретной попытки
CREATE TABLE attempt_questions (
id UUID PRIMARY KEY,
attempt_id UUID NOT NULL, test_id UUID NOT NULL, test_question_id UUID NOT NULL, question_id UUID NOT NULL,
position INTEGER NOT NULL CHECK (position > 0), option_order JSONB NOT NULL DEFAULT '[]',
matching_order JSONB NOT NULL DEFAULT '{}', max_points NUMERIC(10,2) NOT NULL CHECK (max_points > 0),
grading_snapshot JSONB NOT NULL, UNIQUE (attempt_id,position), UNIQUE (attempt_id,test_question_id), UNIQUE (id,question_id),
FOREIGN KEY (attempt_id,test_id) REFERENCES test_attempts(id,test_id) ON DELETE RESTRICT,
FOREIGN KEY (test_question_id,test_id,question_id) REFERENCES test_questions(id,test_id,question_id) ON DELETE RESTRICT,
CHECK (jsonb_typeof(option_order) = 'array'), CHECK (jsonb_typeof(grading_snapshot) = 'object')
);

-- G Тестирование: Один текущий ответ; autosave обновляет запись с revision
CREATE TABLE student_answers (
attempt_question_id UUID PRIMARY KEY, question_id UUID NOT NULL,
answer_data JSONB, awarded_points NUMERIC(10,2) CHECK (awarded_points >= 0),
grading_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (grading_status IN ('pending','auto','manual','needs_review')),
revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0), saved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
graded_by UUID REFERENCES users(id) ON DELETE RESTRICT, graded_at TIMESTAMPTZ,
FOREIGN KEY (attempt_question_id,question_id) REFERENCES attempt_questions(id,question_id) ON DELETE RESTRICT
);

-- G Тестирование: Управляемый пересчёт с сохранением прежнего результата
CREATE TABLE attempt_score_revisions (
id UUID PRIMARY KEY,
attempt_id UUID NOT NULL REFERENCES test_attempts(id) ON DELETE RESTRICT, revised_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
reason TEXT NOT NULL, previous_score NUMERIC(12,2), new_score NUMERIC(12,2) NOT NULL CHECK (new_score >= 0),
grading_snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
idempotency_key TEXT NOT NULL UNIQUE
);

-- H ИИ: Личный общий чат или чат по курсу
CREATE TABLE ai_conversations (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, course_id UUID REFERENCES courses(id) ON DELETE RESTRICT, title TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
archived_at TIMESTAMPTZ, UNIQUE (id,user_id)
);

-- H ИИ: История диалога; нельзя получить чужую беседу
CREATE TABLE ai_messages (
id UUID PRIMARY KEY,
conversation_id UUID NOT NULL, user_id UUID NOT NULL,
role VARCHAR(16) NOT NULL CHECK (role IN ('user','assistant','system')),
content JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY (conversation_id,user_id) REFERENCES ai_conversations(id,user_id) ON DELETE RESTRICT, UNIQUE (id,conversation_id,user_id)
);

-- H ИИ: Совместно действующие ограничения глобально/группа/курс/ученик
CREATE TABLE ai_limit_policies (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, group_id UUID REFERENCES groups(id) ON DELETE RESTRICT, course_id UUID REFERENCES courses(id) ON DELETE RESTRICT,
user_id UUID REFERENCES users(id) ON DELETE RESTRICT, max_daily_requests INTEGER CHECK (max_daily_requests >= 0),
max_daily_tokens BIGINT CHECK (max_daily_tokens >= 0),
max_daily_cost_microunits BIGINT CHECK (max_daily_cost_microunits >= 0),
timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dushanbe', is_active BOOLEAN NOT NULL DEFAULT TRUE,
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
CHECK (num_nonnulls(group_id,course_id,user_id) <= 1),
CHECK (num_nonnulls(max_daily_requests,max_daily_tokens,max_daily_cost_microunits) > 0)
);

-- H ИИ: Жёсткий денежный бюджет провайдеров на период
CREATE TABLE ai_budget_periods (
id UUID PRIMARY KEY,
provider_code TEXT NOT NULL, currency VARCHAR(3) NOT NULL, begins_at TIMESTAMPTZ NOT NULL,
ends_at TIMESTAMPTZ NOT NULL, limit_microunits BIGINT NOT NULL CHECK (limit_microunits >= 0),
reserved_microunits BIGINT NOT NULL DEFAULT 0 CHECK (reserved_microunits >= 0),
spent_microunits BIGINT NOT NULL DEFAULT 0 CHECK (spent_microunits >= 0),
is_active BOOLEAN NOT NULL DEFAULT TRUE, CHECK (ends_at > begins_at),
UNIQUE (provider_code,currency,begins_at)
);

-- H ИИ: Общий суточный счётчик политики; группа делит свой лимит
CREATE TABLE ai_daily_usage (
id UUID PRIMARY KEY,
policy_id UUID NOT NULL REFERENCES ai_limit_policies(id) ON DELETE RESTRICT, usage_date DATE NOT NULL,
used_requests INTEGER NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
reserved_requests INTEGER NOT NULL DEFAULT 0 CHECK (reserved_requests >= 0),
used_tokens BIGINT NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
used_cost_microunits BIGINT NOT NULL DEFAULT 0 CHECK (used_cost_microunits >= 0),
reserved_cost_microunits BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cost_microunits >= 0),
limits_snapshot JSONB NOT NULL, UNIQUE (policy_id,usage_date)
);

-- H ИИ: Запрос, резервирование и фактическое потребление
CREATE TABLE ai_requests (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, conversation_id UUID NOT NULL,
budget_period_id UUID NOT NULL REFERENCES ai_budget_periods(id) ON DELETE RESTRICT,
provider_code TEXT NOT NULL, model_code TEXT NOT NULL, provider_request_id TEXT,
idempotency_key TEXT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'reserved'
CHECK (status IN ('reserved','running','succeeded','failed','unknown','cancelled')),
reserved_cost_microunits BIGINT NOT NULL CHECK (reserved_cost_microunits >= 0),
actual_cost_microunits BIGINT CHECK (actual_cost_microunits >= 0),
input_tokens BIGINT CHECK (input_tokens >= 0), output_tokens BIGINT CHECK (output_tokens >= 0),
error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ,
UNIQUE (user_id,idempotency_key), UNIQUE (id,user_id),
FOREIGN KEY (conversation_id,user_id) REFERENCES ai_conversations(id,user_id) ON DELETE RESTRICT
);

-- H ИИ: Один запрос резервирует все применимые суточные политики
CREATE TABLE ai_request_reservations (
request_id UUID NOT NULL REFERENCES ai_requests(id) ON DELETE RESTRICT, daily_usage_id UUID NOT NULL REFERENCES ai_daily_usage(id) ON DELETE RESTRICT,
reserved_requests INTEGER NOT NULL DEFAULT 1 CHECK (reserved_requests >= 0),
reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens >= 0),
reserved_cost_microunits BIGINT NOT NULL CHECK (reserved_cost_microunits >= 0),
settled_at TIMESTAMPTZ, PRIMARY KEY (request_id,daily_usage_id)
);

-- H ИИ: Журнал резервов, фактических расходов и освобождения
CREATE TABLE ai_usage_ledger (
id UUID PRIMARY KEY,
request_id UUID NOT NULL REFERENCES ai_requests(id) ON DELETE RESTRICT,
event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('reserve','settle','release','adjust')),
reserved_delta_microunits BIGINT NOT NULL DEFAULT 0,
spent_delta_microunits BIGINT NOT NULL DEFAULT 0,
idempotency_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- H ИИ: История разборов; последний выбирается по created_at
CREATE TABLE ai_analyses (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, course_id UUID REFERENCES courses(id) ON DELETE RESTRICT,
attempt_id UUID REFERENCES test_attempts(id) ON DELETE RESTRICT, request_id UUID NOT NULL REFERENCES ai_requests(id) ON DELETE RESTRICT,
analysis_type VARCHAR(24) NOT NULL CHECK (analysis_type IN ('mistakes','recommendations','nct_progress')),
content JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- I Бонусы: Баланс — сумма операций журнала, поле balance не хранится
CREATE TABLE bonus_accounts (
id UUID PRIMARY KEY,
user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- I Бонусы: Настраиваемые правила; значения не зашиты в код
CREATE TABLE bonus_rules (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, event_type VARCHAR(32) NOT NULL,
points BIGINT NOT NULL CHECK (points >= 0), conditions JSONB NOT NULL DEFAULT '{}',
is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- I Бонусы: Неизменяемый журнал начислений, списаний и компенсаций
CREATE TABLE bonus_transactions (
id UUID PRIMARY KEY,
account_id UUID NOT NULL REFERENCES bonus_accounts(id) ON DELETE RESTRICT, delta BIGINT NOT NULL CHECK (delta <> 0),
rule_id UUID REFERENCES bonus_rules(id) ON DELETE RESTRICT, source_event_key TEXT NOT NULL,
operation VARCHAR(16) NOT NULL CHECK (operation IN ('earn','spend','refund','adjust')),
reverses_id UUID REFERENCES bonus_transactions(id) ON DELETE RESTRICT, performed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (account_id,source_event_key), CHECK (reverses_id IS NULL OR reverses_id <> id)
);

-- I Бонусы: Обмен бонусов на пакеты ИИ; скидки пока не активируем
CREATE TABLE bonus_offers (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, price_points BIGINT NOT NULL CHECK (price_points > 0),
ai_requests_count INTEGER NOT NULL CHECK (ai_requests_count > 0),
valid_days INTEGER CHECK (valid_days > 0), max_per_user_per_day INTEGER CHECK (max_per_user_per_day > 0),
is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- I Бонусы: Однократный обмен с фиксацией условий предложения
CREATE TABLE bonus_redemptions (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, offer_id UUID NOT NULL REFERENCES bonus_offers(id) ON DELETE RESTRICT,
transaction_id UUID NOT NULL UNIQUE REFERENCES bonus_transactions(id) ON DELETE RESTRICT, offer_snapshot JSONB NOT NULL,
idempotency_key TEXT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'completed'
CHECK (status IN ('completed','reversed')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (user_id,idempotency_key), UNIQUE (id,user_id)
);

-- I Бонусы: Пакет запросов ИИ, полученный за бонусы
CREATE TABLE ai_credit_grants (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, redemption_id UUID NOT NULL UNIQUE,
total_requests INTEGER NOT NULL CHECK (total_requests > 0),
used_requests INTEGER NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
reserved_requests INTEGER NOT NULL DEFAULT 0 CHECK (reserved_requests >= 0),
granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
UNIQUE (id,user_id), FOREIGN KEY (redemption_id,user_id) REFERENCES bonus_redemptions(id,user_id) ON DELETE RESTRICT,
CHECK (used_requests + reserved_requests <= total_requests), CHECK (expires_at IS NULL OR expires_at > granted_at)
);
ALTER TABLE ai_requests ADD COLUMN credit_grant_id UUID;
ALTER TABLE ai_requests ADD CONSTRAINT ai_request_credit_owner_fk
FOREIGN KEY (credit_grant_id,user_id) REFERENCES ai_credit_grants(id,user_id) ON DELETE RESTRICT;

-- I Бонусы: Определения достижений
CREATE TABLE achievements (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
icon_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT, criteria JSONB NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- I Бонусы: Выданные достижения
CREATE TABLE user_achievements (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE RESTRICT,
awarded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, source_event_key TEXT NOT NULL,
PRIMARY KEY (user_id,achievement_id)
);

-- J Уведомления: Согласие на сообщения бота отдельно от Telegram-входа
CREATE TABLE telegram_connections (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, bot_id TEXT NOT NULL, chat_id BIGINT NOT NULL,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','disconnected')),
connected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, blocked_at TIMESTAMPTZ,
UNIQUE (bot_id,chat_id), UNIQUE (user_id,bot_id)
);

-- J Уведомления: Web Push подписки устройств
CREATE TABLE push_subscriptions (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, endpoint TEXT NOT NULL UNIQUE,
p256dh TEXT NOT NULL, auth_secret TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
revoked_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ
);

-- J Уведомления: Настройки по типу события и каналу
CREATE TABLE notification_preferences (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, event_code TEXT NOT NULL,
channel VARCHAR(16) NOT NULL CHECK (channel IN ('in_app','push','telegram')),
enabled BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id,event_code,channel)
);

-- J Уведомления: Шаблон, аудитория и время рассылки
CREATE TABLE broadcast_campaigns (
id UUID PRIMARY KEY,
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, title TEXT NOT NULL, content JSONB NOT NULL,
audience_filter JSONB NOT NULL, channels JSONB NOT NULL, timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dushanbe',
scheduled_at TIMESTAMPTZ,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','completed','cancelled','failed')),
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ
);

-- J Уведомления: Персональная запись уведомления; получатели кампании фиксируются
CREATE TABLE notifications (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, campaign_id UUID REFERENCES broadcast_campaigns(id) ON DELETE RESTRICT,
event_code TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, target_path TEXT,
dedupe_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TIMESTAMPTZ,
UNIQUE (user_id,dedupe_key)
);

-- J Уведомления: Одна запись на конкретное устройство/Telegram chat
CREATE TABLE notification_deliveries (
id UUID PRIMARY KEY,
notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE RESTRICT,
channel VARCHAR(16) NOT NULL CHECK (channel IN ('push','telegram')),
push_subscription_id UUID REFERENCES push_subscriptions(id) ON DELETE RESTRICT, telegram_connection_id UUID REFERENCES telegram_connections(id) ON DELETE RESTRICT,
destination_key TEXT NOT NULL, provider_message_id TEXT,
status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','unknown','cancelled')),
attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
next_attempt_at TIMESTAMPTZ, last_error_code TEXT, sent_at TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (notification_id,channel,destination_key),
CHECK ((channel = 'push' AND push_subscription_id IS NOT NULL AND telegram_connection_id IS NULL)
OR (channel = 'telegram' AND telegram_connection_id IS NOT NULL AND push_subscription_id IS NULL))
);

-- K Инфраструктура: Редкие события для активности и streak; не видеотелеметрия каждую секунду
CREATE TABLE learning_activity_events (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, lesson_id UUID REFERENCES lessons(id) ON DELETE RESTRICT,
attempt_id UUID REFERENCES test_attempts(id) ON DELETE RESTRICT, event_code TEXT NOT NULL, source_event_key TEXT NOT NULL,
occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, metadata JSONB NOT NULL DEFAULT '{}',
UNIQUE (user_id,source_event_key)
);

-- K Инфраструктура: Очередь PostgreSQL с lease и retry
CREATE TABLE background_jobs (
id UUID PRIMARY KEY,
job_type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', dedupe_key TEXT NOT NULL UNIQUE,
status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
locked_by TEXT, lease_expires_at TIMESTAMPTZ,
attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
last_error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ
);

-- K Инфраструктура: Повтор HTTP-запроса возвращает тот же результат
CREATE TABLE idempotency_keys (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
request_hash TEXT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
response_code INTEGER, response_body JSONB,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ NOT NULL,
UNIQUE (user_id,operation,idempotency_key), CHECK (expires_at > created_at)
);

-- K Инфраструктура: Публичные/служебные настройки, но не API-ключи
CREATE TABLE platform_settings (
key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Запросы кабинета, очередей и отчётов. Дополнительные индексы FK добавлены ниже.
CREATE INDEX group_members_active_idx ON group_members(user_id,group_id) WHERE status = 'active';
CREATE INDEX group_announcements_feed_idx ON group_announcements(group_id,is_pinned,published_at);
CREATE INDEX course_enrollments_user_idx ON course_enrollments(user_id,expires_at);
CREATE INDEX questions_filter_idx ON questions(bank_id,status,question_type,language_code,difficulty);
CREATE INDEX questions_subject_idx ON questions(subject_id,status);
CREATE INDEX attempts_user_history_idx ON test_attempts(user_id,started_at);
CREATE UNIQUE INDEX attempts_one_open_idx ON test_attempts(assignment_id,user_id)
WHERE status IN ('in_progress','paused');
CREATE INDEX ai_messages_history_idx ON ai_messages(conversation_id,created_at);
CREATE INDEX ai_analyses_latest_idx ON ai_analyses(user_id,analysis_type,created_at);
CREATE INDEX bonus_ledger_balance_idx ON bonus_transactions(account_id,created_at);
CREATE INDEX notifications_inbox_idx ON notifications(user_id,created_at);
CREATE INDEX delivery_pending_idx ON notification_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX jobs_claim_idx ON background_jobs(available_at,created_at) WHERE status = 'pending';
CREATE INDEX jobs_lease_idx ON background_jobs(lease_expires_at) WHERE status = 'running';
CREATE INDEX learning_activity_user_idx ON learning_activity_events(user_id,occurred_at);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at);

-- Эффективный доступ. Вызывать с user_id из серверной сессии, а не из тела запроса.
-- Проверка сессии и полномочий администратора/преподавателя выполняется отдельно.
CREATE FUNCTION can_access_module(p_user UUID, p_module UUID, p_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM users u
  JOIN course_enrollments e ON e.user_id = u.id
  JOIN courses c ON c.id = e.course_id
  JOIN course_modules m ON m.course_id = c.id
  JOIN module_access_grants g ON g.user_id = u.id AND g.module_id = m.id AND g.course_id = c.id
  WHERE u.id = p_user AND m.id = p_module AND u.status = 'active'
   AND u.onboarding_completed_at IS NOT NULL AND c.status = 'published' AND m.status = 'published'
   AND e.revoked_at IS NULL AND e.begins_at <= p_at AND (e.expires_at IS NULL OR e.expires_at > p_at)
   AND g.revoked_at IS NULL AND g.begins_at <= p_at AND (g.expires_at IS NULL OR g.expires_at > p_at)
 );
$$;

-- Сериализация правок дочерних элементов с публикацией вопроса.
CREATE FUNCTION assert_question_draft(p_question UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
 SELECT status INTO v_status FROM questions WHERE id = p_question FOR UPDATE;
 IF v_status IS DISTINCT FROM 'draft' THEN
  RAISE EXCEPTION 'QUESTION_IMMUTABLE: create a question copy';
 END IF;
END; $$;

CREATE FUNCTION guard_question_child() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN PERFORM assert_question_draft(OLD.question_id); END IF;
 IF TG_OP <> 'DELETE' THEN
  IF TG_OP = 'INSERT' THEN PERFORM assert_question_draft(NEW.question_id);
  ELSIF NEW.question_id <> OLD.question_id THEN PERFORM assert_question_draft(NEW.question_id); END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END; $$;

CREATE FUNCTION guard_question() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  IF OLD.status <> 'draft' THEN
   IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'QUESTION_IMMUTABLE'; END IF;
   IF NEW.status = 'draft' OR (to_jsonb(NEW) - 'status' - 'updated_at') <>
       (to_jsonb(OLD) - 'status' - 'updated_at') THEN RAISE EXCEPTION 'QUESTION_IMMUTABLE'; END IF;
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF NEW.status = 'published' THEN
  IF NOT EXISTS (SELECT 1 FROM question_answer_keys k WHERE k.question_id = NEW.id
       AND k.status = 'verified' AND k.answer_data IS NOT NULL) THEN
   RAISE EXCEPTION 'QUESTION_REQUIRES_VERIFIED_KEY';
  END IF;
  IF NEW.question_type IN ('single_choice','multiple_choice') AND
     (SELECT count(*) FROM question_options WHERE question_id = NEW.id) < 2 THEN
   RAISE EXCEPTION 'QUESTION_REQUIRES_OPTIONS';
  END IF;
  IF NEW.question_type = 'matching' AND (
      jsonb_typeof(NEW.interaction_settings -> 'requireAllLeft') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(NEW.interaction_settings -> 'allowRightReuse') IS DISTINCT FROM 'boolean'
      OR NOT EXISTS (SELECT 1 FROM question_matching_items WHERE question_id=NEW.id AND side='left')
      OR NOT EXISTS (SELECT 1 FROM question_matching_items WHERE question_id=NEW.id AND side='right')
     ) THEN RAISE EXCEPTION 'MATCHING_RULES_AND_ITEMS_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER questions_guard BEFORE INSERT OR UPDATE OR DELETE ON questions
FOR EACH ROW EXECUTE FUNCTION guard_question();
CREATE TRIGGER question_options_guard BEFORE INSERT OR UPDATE OR DELETE ON question_options
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_matching_guard BEFORE INSERT OR UPDATE OR DELETE ON question_matching_items
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON question_answer_keys
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON question_assets
FOR EACH ROW EXECUTE FUNCTION guard_question_child();
CREATE TRIGGER question_topics_guard BEFORE INSERT OR UPDATE OR DELETE ON question_topics
FOR EACH ROW EXECUTE FUNCTION guard_question_child();

CREATE FUNCTION guard_test_question() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  SELECT status INTO v_status FROM tests WHERE id=OLD.test_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  SELECT status INTO v_status FROM tests WHERE id=NEW.test_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END; $$;

CREATE FUNCTION guard_test() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  IF OLD.status <> 'draft' THEN
   IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
   IF NEW.status = 'draft' OR (to_jsonb(NEW) - 'status' - 'updated_at') <>
      (to_jsonb(OLD) - 'status' - 'updated_at') THEN RAISE EXCEPTION 'TEST_IMMUTABLE'; END IF;
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF NEW.status = 'published' THEN
  IF NOT EXISTS (SELECT 1 FROM test_questions WHERE test_id=NEW.id) THEN
   RAISE EXCEPTION 'TEST_REQUIRES_QUESTIONS';
  END IF;
  IF EXISTS (SELECT 1 FROM test_questions tq JOIN questions q ON q.id=tq.question_id
       WHERE tq.test_id=NEW.id AND q.status <> 'published') THEN
   RAISE EXCEPTION 'TEST_REQUIRES_PUBLISHED_QUESTIONS';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER tests_guard BEFORE INSERT OR UPDATE OR DELETE ON tests
FOR EACH ROW EXECUTE FUNCTION guard_test();
CREATE TRIGGER test_questions_guard BEFORE INSERT OR UPDATE OR DELETE ON test_questions
FOR EACH ROW EXECUTE FUNCTION guard_test_question();

-- Журналы не редактируются: исправление — новая компенсирующая операция.
CREATE FUNCTION forbid_ledger_rewrite() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'APPEND_ONLY_LEDGER'; END; $$;
CREATE TRIGGER bonus_transactions_append_only BEFORE UPDATE OR DELETE ON bonus_transactions
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();
CREATE TRIGGER ai_usage_append_only BEFORE UPDATE OR DELETE ON ai_usage_ledger
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();
CREATE TRIGGER score_revisions_append_only BEFORE UPDATE OR DELETE ON attempt_score_revisions
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();

-- Служебная запись аудита может быть привязана к любому объекту платформы.
-- entity_id — намеренно полиморфный идентификатор, не FK.
ALTER TABLE audit_events ADD COLUMN entity_type TEXT;
ALTER TABLE audit_events ADD COLUMN entity_id UUID;

-- Первоначальный справочник ролей; UUID фиксированы только для seed.
INSERT INTO roles (id,code) VALUES
 ('00000000-0000-4000-8000-000000000001','owner'),
 ('00000000-0000-4000-8000-000000000002','admin'),
 ('00000000-0000-4000-8000-000000000003','teacher'),
 ('00000000-0000-4000-8000-000000000004','student');

-- Правила авторизации из первого инкремента:
-- ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА BACKEND (не реализованы одним этим DDL).
-- 1. Регистрация: SMS подтверждает номер; затем users + profile + phone +
--    password + student role создаются транзакционно, статус pending.
--    Не сохранять выбранный пароль в challenge: передавать его при финализации.
--    Первого owner создать контролируемой bootstrap-командой, не публичным API.
-- 2. Telegram: проверять подпись/issuer/audience/expiry/nonce и state/PKCE выбранного
--    официального flow; subject брать из проверенного токена. Не доверять JSON клиента.
--    Не объединять пользователей по имени, username или совпавшему телефону.
--    provider_profile содержит только разрешённые публичные поля, не ID/access tokens.
-- 3. Telegram-only аккаунт может не иметь phone/password. Полноценный учебный доступ
--    требует active и завершённого профиля. Обязательность телефона перед активацией
--    пока не согласована. Password row создаётся лишь при установке пароля.
-- 4. Для установки пароля после Telegram-входа: свежая повторная аутентификация;
--    для входа по телефону дополнительно нужен привязанный подтверждённый номер.
-- 5. Привязка Telegram и изменение номера требуют свежего подтверждения личности.
--    Нельзя отвязать последний доступный способ входа. Нельзя использовать SMS
--    регистрации для смены пароля существующего аккаунта.
-- 6. SMS-код: криптографическая генерация; HMAC с серверным секретом + challenge ID
--    либо стойкое хеширование. Простой SHA256 короткого кода недостаточен.
--    Пять попыток здесь — предложение; TTL, cooldown и дневные лимиты настроить в API.
--    При перевыпуске кода атомарно инвалидировать старые: блокировка по номеру/назначению.
-- 7. Восстановление: только уже привязанный verified номер; сверять snapshot номера
--    с user_phones, состояние аккаунта и purpose. Неизвестному номеру вернуть тот же
--    общий ответ, без SMS и реального reset challenge. Ограничить IP/номер/общий бюджет.
-- 8. Финальный reset endpoint принимает challenge ID, код и новый пароль вместе.
--    Под блокировками атомарно проверить TTL/попытки/неиспользованность, заменить hash,
--    consume challenge, отозвать все сессии и прочие reset challenges, записать аудит.
--    Не создавать бессрочный флаг password_reset_allowed после проверки кода.
-- 9. SMS API вызывается после фиксации challenge. Текст и код не сохраняются в delivery,
--    логах, metadata. При timeout неизвестного результата сверить ID/идемпотентность
--    провайдера, не отправлять новые платные SMS вслепую. Таблица delivery — журнал,
--    не полноценный outbox с возможностью восстановить исходный код для worker.
-- 10. Refresh: непрозрачные случайные токены; хранить только hash. Ротация под
--     блокировкой session/token; used_at старого + новый token в одной транзакции.
--     Повтор использованного токена отзывает всю session. Хранить использованные
--     хеши до окончания окна обнаружения replay. expires_at токена <= срока session.
-- 11. Каждый защищённый запрос проверяет user status/onboarding + session expiry/revoke
--     + права на ресурс. Отзыв/блокировка действует и для ещё не истёкшего access JWT.
--     Статeless JWT без серверной проверки этого не обеспечивает.
-- 12. Пароли — Argon2id или bcrypt с согласованными параметрами. Cookies: HttpOnly,
--     Secure, SameSite; CSRF/CORS по фактическим доменам. Секреты провайдера — окружение.
-- 13. updated_at обновляет backend; автоматического триггера пока нет. Проверять IANA
--     timezone; обязательность first/last_name при завершении профиля — в API.
-- 14. Физическое удаление пользователей не входит в эту версию; FK RESTRICT сохраняют
--     связи. Cleanup временных данных/сроки хранения IP/аудита разработать отдельно.
-- 15. roles/user_roles не дают доступ ко всем курсам: course_teachers и
--     course_enrollments с FK на users. Роль student должна проверяться сервером.
-- 16. user_profiles.avatar_asset_id связан с assets в этом полном baseline.
-- 17. Остальные модули включены ниже; внедряются поэтапно.

-- Дополнительные обязательные правила приложения:
-- 1. FK гарантируют принадлежность модуля курсу, но активность и сроки нужно
--    проверять на КАЖДОМ защищённом запросе, включая выдачу файла, тест и offline.
-- 2. group_members/group_teachers/group_announcements не выдают доступ к курсам.
-- 3. Видимый замок и отсутствие grant — не признак зарегистрированной неоплаты.
--    Платежи внутри платформы не согласованы, поэтому payments здесь нет.
-- 4. translations JSONB — необязательный словарь ru/tg/en, валидируется по DTO;
--    основное название хранится в title. content.blocks — общий контракт контента.
-- 5. При публикации API проверяет тип и ВСЕ ссылки answer_data; триггер проверяет
--    наличие verified ключа и базовую структуру, но не полную JSON Schema.
-- 6. Числовые допуски/частичные баллы/показ ответов/лимиты НЦТ — предложения,
--    не окончательные решения; задать при создании теста и сохранить policy_snapshot.
-- 7. grading_snapshot — служебный снимок ключа и правил для воспроизводимости;
--    он не второй редактируемый источник ключа. Никогда не отдавать его ученику.
-- 8. Начало/сдача/истечение/пауза: транзакция и блокировка attempt; после сдачи
--    запретить autosave. Конкуренцию autosave контролирует revision.
-- 9. Лимит попыток проверять с блокировкой по assignment/user до вставки.
--    В v0.2 лимит считается на назначение. Глобальная одна попытка НЦТ не введена.
-- 10. student_answers.awarded_points <= attempt_questions.max_points проверяет API.
-- 11. AI: заблокировать бюджет и все применимые daily_usage в стабильном порядке;
--    зарезервировать до внешнего вызова; после ответа атомарно settle/release.
--    Фактический расход записывать даже при превышении резерва; остановить новые
--    запросы. При timeout не освобождать резерв и не повторять оплату вслепую.
-- 12. Глобальные/групповые/курсовые политики здесь имеют ОБЩИЙ суточный пул.
--    Личный лимит задаётся policy.user_id. Единицы/значения и правила пакетов — уточнить.
--    Пакет за бонусы не обходит денежный бюджет центра.
-- 13. Баланс бонусов = SUM(delta); перед spend/refund блокировать bonus_accounts,
--    проверять остаток, писать ledger + redemption + credit grant одной транзакцией.
-- 14. Уведомления push проверять по владельцу notification/subscription, Telegram —
--    по владельцу connection; webhook — по подписи/секрету, без секретов в логах.
--    Exactly-once доставка внешнего сообщения не гарантируется одним UNIQUE.
-- 15. Broadcast audience_filter — валидируемый DSL, не произвольный SQL.
-- 16. Worker использует FOR UPDATE SKIP LOCKED, lease и идемпотентные обработчики.
--    payload/background_jobs/idempotency response не содержат пароли/OTP/токены.
-- 17. Агрегаты прогресса, рейтинга, streak вычисляются из первичных данных.
--    Порог завершения и знаменатель прогресса ещё не согласованы.
-- 18. Иерархию topics проверять на циклы в транзакции (не только parent_id <> id).
-- 19. Права staff на банки/группы/курсы проверяются по назначению; у одного teacher
--    нет автоматического доступа ко всем материалам. Родительские FK не являются ACL.
-- 20. Прогресс, ключи, сессии, аудит и учебные результаты не доступны публичным SQL.
--    Клиент работает только через API. Эта схема не включает готовую RLS-политику.
-- 21. INSERT/UPDATE балансов резервов, оценок и статусов не доступны ученическому API.
--    DB runtime role и миграционный владелец должны быть разделены при деплое.

-- Индексы дочерних FK (проверены по каталогу PostgreSQL).
CREATE INDEX fk_achievements_1_idx ON achievements (icon_asset_id);
CREATE INDEX fk_ai_analyses_2_idx ON ai_analyses (attempt_id);
CREATE INDEX fk_ai_analyses_3_idx ON ai_analyses (course_id);
CREATE INDEX fk_ai_analyses_4_idx ON ai_analyses (request_id);
CREATE INDEX fk_ai_conversations_5_idx ON ai_conversations (course_id);
CREATE INDEX fk_ai_conversations_6_idx ON ai_conversations (user_id);
CREATE INDEX fk_ai_credit_grants_7_idx ON ai_credit_grants (redemption_id,user_id);
CREATE INDEX fk_ai_credit_grants_8_idx ON ai_credit_grants (user_id);
CREATE INDEX fk_ai_limit_policies_9_idx ON ai_limit_policies (course_id);
CREATE INDEX fk_ai_limit_policies_10_idx ON ai_limit_policies (created_by);
CREATE INDEX fk_ai_limit_policies_11_idx ON ai_limit_policies (group_id);
CREATE INDEX fk_ai_limit_policies_12_idx ON ai_limit_policies (user_id);
CREATE INDEX fk_ai_messages_13_idx ON ai_messages (conversation_id,user_id);
CREATE INDEX fk_ai_request_reservations_14_idx ON ai_request_reservations (daily_usage_id);
CREATE INDEX fk_ai_requests_15_idx ON ai_requests (credit_grant_id,user_id);
CREATE INDEX fk_ai_requests_16_idx ON ai_requests (budget_period_id);
CREATE INDEX fk_ai_requests_17_idx ON ai_requests (conversation_id,user_id);
CREATE INDEX fk_ai_usage_ledger_18_idx ON ai_usage_ledger (request_id);
CREATE INDEX fk_announcement_assets_19_idx ON announcement_assets (asset_id);
CREATE INDEX fk_asset_aliases_20_idx ON asset_aliases (asset_id);
CREATE INDEX fk_assets_21_idx ON assets (uploaded_by);
CREATE INDEX fk_attempt_questions_22_idx ON attempt_questions (attempt_id,test_id);
CREATE INDEX fk_attempt_questions_23_idx ON attempt_questions (test_question_id,test_id,question_id);
CREATE INDEX fk_attempt_score_revisions_24_idx ON attempt_score_revisions (attempt_id);
CREATE INDEX fk_attempt_score_revisions_25_idx ON attempt_score_revisions (revised_by);
CREATE INDEX fk_bonus_offers_26_idx ON bonus_offers (created_by);
CREATE INDEX fk_bonus_redemptions_27_idx ON bonus_redemptions (offer_id);
CREATE INDEX fk_bonus_rules_28_idx ON bonus_rules (created_by);
CREATE INDEX fk_bonus_transactions_29_idx ON bonus_transactions (performed_by);
CREATE INDEX fk_bonus_transactions_30_idx ON bonus_transactions (reverses_id);
CREATE INDEX fk_bonus_transactions_31_idx ON bonus_transactions (rule_id);
CREATE INDEX fk_broadcast_campaigns_32_idx ON broadcast_campaigns (created_by);
CREATE INDEX fk_course_enrollments_33_idx ON course_enrollments (course_id);
CREATE INDEX fk_course_enrollments_34_idx ON course_enrollments (granted_by);
CREATE INDEX fk_course_enrollments_35_idx ON course_enrollments (revoked_by);
CREATE INDEX fk_course_favorites_36_idx ON course_favorites (course_id);
CREATE INDEX fk_course_teachers_37_idx ON course_teachers (assigned_by);
CREATE INDEX fk_course_teachers_38_idx ON course_teachers (user_id);
CREATE INDEX fk_courses_39_idx ON courses (cover_asset_id);
CREATE INDEX fk_courses_40_idx ON courses (created_by);
CREATE INDEX fk_courses_41_idx ON courses (subject_id);
CREATE INDEX fk_group_announcements_42_idx ON group_announcements (author_id);
CREATE INDEX fk_group_members_43_idx ON group_members (added_by);
CREATE INDEX fk_group_members_44_idx ON group_members (user_id);
CREATE INDEX fk_group_teachers_45_idx ON group_teachers (assigned_by);
CREATE INDEX fk_group_teachers_46_idx ON group_teachers (user_id);
CREATE INDEX fk_groups_47_idx ON groups (created_by);
CREATE INDEX fk_learning_activity_events_48_idx ON learning_activity_events (attempt_id);
CREATE INDEX fk_learning_activity_events_49_idx ON learning_activity_events (lesson_id);
CREATE INDEX fk_lesson_notes_50_idx ON lesson_notes (lesson_id);
CREATE INDEX fk_lesson_notes_51_idx ON lesson_notes (user_id);
CREATE INDEX fk_lesson_progress_52_idx ON lesson_progress (lesson_id);
CREATE INDEX fk_lesson_resources_53_idx ON lesson_resources (asset_id);
CREATE INDEX fk_lessons_54_idx ON lessons (created_by);
CREATE INDEX fk_lessons_55_idx ON lessons (module_id,course_id);
CREATE INDEX fk_lessons_56_idx ON lessons (video_asset_id);
CREATE INDEX fk_module_access_grants_57_idx ON module_access_grants (granted_by);
CREATE INDEX fk_module_access_grants_58_idx ON module_access_grants (module_id,course_id);
CREATE INDEX fk_module_access_grants_59_idx ON module_access_grants (revoked_by);
CREATE INDEX fk_module_access_grants_60_idx ON module_access_grants (user_id,course_id);
CREATE INDEX fk_notification_deliveries_61_idx ON notification_deliveries (push_subscription_id);
CREATE INDEX fk_notification_deliveries_62_idx ON notification_deliveries (telegram_connection_id);
CREATE INDEX fk_notifications_63_idx ON notifications (campaign_id);
CREATE INDEX fk_offline_downloads_64_idx ON offline_downloads (asset_id);
CREATE INDEX fk_offline_downloads_65_idx ON offline_downloads (lesson_id);
CREATE INDEX fk_offline_downloads_66_idx ON offline_downloads (user_id);
CREATE INDEX fk_platform_settings_67_idx ON platform_settings (updated_by);
CREATE INDEX fk_push_subscriptions_68_idx ON push_subscriptions (user_id);
CREATE INDEX fk_question_answer_keys_69_idx ON question_answer_keys (verified_by);
CREATE INDEX fk_question_assets_70_idx ON question_assets (asset_id);
CREATE INDEX fk_question_banks_71_idx ON question_banks (owner_id);
CREATE INDEX fk_question_banks_72_idx ON question_banks (subject_id);
CREATE INDEX fk_question_duplicate_links_73_idx ON question_duplicate_links (duplicate_of_id);
CREATE INDEX fk_question_duplicate_links_74_idx ON question_duplicate_links (marked_by);
CREATE INDEX fk_question_import_errors_75_idx ON question_import_errors (import_id);
CREATE INDEX fk_question_imports_76_idx ON question_imports (initiated_by);
CREATE INDEX fk_question_topics_77_idx ON question_topics (question_id,subject_id);
CREATE INDEX fk_question_topics_78_idx ON question_topics (topic_id,subject_id);
CREATE INDEX fk_questions_79_idx ON questions (bank_id,subject_id);
CREATE INDEX fk_questions_80_idx ON questions (created_by);
CREATE INDEX fk_questions_81_idx ON questions (import_id);
CREATE INDEX fk_questions_82_idx ON questions (source_question_id);
CREATE INDEX fk_student_answers_83_idx ON student_answers (attempt_question_id,question_id);
CREATE INDEX fk_student_answers_84_idx ON student_answers (graded_by);
CREATE INDEX fk_test_assignments_85_idx ON test_assignments (assigned_by);
CREATE INDEX fk_test_assignments_86_idx ON test_assignments (course_id);
CREATE INDEX fk_test_assignments_87_idx ON test_assignments (group_id);
CREATE INDEX fk_test_assignments_88_idx ON test_assignments (lesson_id);
CREATE INDEX fk_test_assignments_89_idx ON test_assignments (test_id);
CREATE INDEX fk_test_assignments_90_idx ON test_assignments (user_id);
CREATE INDEX fk_test_attempts_91_idx ON test_attempts (assignment_id,test_id);
CREATE INDEX fk_test_attempts_92_idx ON test_attempts (test_id);
CREATE INDEX fk_test_questions_93_idx ON test_questions (question_id);
CREATE INDEX fk_tests_94_idx ON tests (copied_from_id);
CREATE INDEX fk_tests_95_idx ON tests (created_by);
CREATE INDEX fk_topics_96_idx ON topics (parent_id,subject_id);
CREATE INDEX fk_topics_97_idx ON topics (section_id,subject_id);
CREATE INDEX fk_user_achievements_98_idx ON user_achievements (achievement_id);
CREATE INDEX fk_user_invitations_99_idx ON user_invitations (accepted_by);
CREATE INDEX fk_user_invitations_100_idx ON user_invitations (invited_by);
CREATE INDEX fk_user_profiles_101_idx ON user_profiles (avatar_asset_id);
```

## 8. Acceptance checklist for Codex and Claude Code

- [ ] Inspected existing code, database and migration history; chose empty-DB baseline or incremental reconciliation explicitly.
- [ ] Added ordered JavaScript migrations in src/migrations, preserving the exact target definitions and deferred relationships.
- [ ] Included every intended function, trigger, index and role seed once.
- [ ] Preserved mandatory repositories and one-client application transaction boundaries.
- [ ] Kept groups independent from course/module grants and correctness only in question_answer_keys.
- [ ] Applied migrations and relevant negative tests in an isolated database, without claiming unrun checks.
- [ ] Verified actual catalog definitions and recorded server/tool versions, commands and results.
- [ ] Documented destructive/unsupported rollback honestly and kept production data intact.
- [ ] Updated shared documentation/progress so the next agent can continue without reinitializing or replaying applied migrations.

## 9. Official implementation references

Consult the installed tool version before copying configuration or CLI options. These references support migration and transaction mechanics; the EVEREST schema and product rules come from the supplied project sources.

- node-pg-migrate migration definitions: https://salsita.github.io/node-pg-migrate/migrations/
- node-pg-migrate raw SQL operations: https://salsita.github.io/node-pg-migrate/migrations/misc
- node-postgres transactions and client ownership: https://node-postgres.com/features/transactions
- node-postgres parameterized queries: https://node-postgres.com/features/queries

## 10. Suggested implementation prompt

> Read AGENTS.md, CLAUDE.md, documentation.md and root schema_tables.md. Inspect the current repository, installed pg/node-pg-migrate versions, applied migrations and actual database catalog. Create JavaScript node-pg-migrate migrations for the complete 81-table EVEREST v0.2 target in schema_tables.md, preserving its exact columns, constraints, 156 foreign keys, indexes, functions, triggers and four role seed rows. If objects already exist, create incremental reconciliation migrations; do not rerun the full baseline, delete data, or modify applied migrations. Keep the existing layer-based project structure and mandatory src/repositories layer. Validate up and the declared rollback policy in a disposable PostgreSQL database, compare the resulting catalog, run the specified integrity checks, and record actual commands/results plus remaining product decisions in docs/progress.md. Do not implement unrelated endpoints or external provider calls as part of this task.

## 11. Verification of this document

On 2026-10-24, the SQL block extracted from this Markdown was compared byte-for-byte with the source baseline and applied successfully to a fresh PGlite embedded PostgreSQL database. The resulting column, constraint and index definitions matched the reference catalog. Observed counts: 81 application tables, 641 columns, 156 foreign keys, 290 indexes, 7 functions, 11 user-defined triggers and the four intended role seed rows. All 81 table headings have corresponding dictionary entries.

This check validates the self-contained SQL reference and dictionary consistency. No JavaScript migration files were generated or executed in this documentation task, and no live server database was changed. Migration up/down and application integration tests remain the responsibility of the subsequent implementation task.
