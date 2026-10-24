# Project rules and evidence

## Confirmed structure and unknown syntax

Use JavaScript, Express, PostgreSQL, pg and node-pg-migrate with the documented layer structure and mandatory repositories. For a new repository, use CommonJS, async/await and kebab-case filenames as provisional defaults. Keep error handling in configs and secrets out of Git.

## EVEREST domain invariants

- One center and one users.id across verified login methods.
- Groups never grant course access; course and module grants are separate.
- Published questions and tests are immutable; correctness exists only in question_answer_keys.
- Exclude group_courses, EduCRM, integrated video calls, multitenancy and question_versions.
- Do not silently settle open product choices.

## Database and migration workflow

Treat the complete SQL as the clean-database reference baseline. Use ordered JavaScript migrations in src/migrations. For an existing database inspect catalog and migration history and reconcile incrementally; never run a baseline over existing auth tables. Preserve all constraints, indexes, functions and triggers. Test destructive rollback only in a disposable database.

## Integration and test boundaries

Importing app.js constructs the app only. server.js starts HTTP and handles graceful shutdown. Use route -> controller -> service -> repository -> pg. All application SQL, including readiness, belongs in repositories. Services own transaction scope and repositories/transaction-repository.js owns one client lifecycle. Update docs with actual results.

