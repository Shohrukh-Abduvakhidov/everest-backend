---
name: session-handoff
description: Maintain concise, evidence-based roadmap and handoff continuity for an existing repository across coding sessions and agent transfers.
---

# Session Handoff

Use this skill when starting, completing, or transferring repository work. Treat repository evidence as authoritative; the roadmap and handoff may be stale.

## Start a session

1. Inspect `git status`, the current branch, recent commits, and existing diffs without discarding changes.
2. Read the roadmap and current handoff, then the architecture, progress, decisions, and implemented API documents.
3. Identify the selected milestone and inspect its actual code, migrations, tests, and configuration.
4. Compare documented status with implementation. Correct mismatches before new work and never equate schema presence with feature completion.
5. Keep work within the selected milestone and preserve unrelated user changes.

## Verify and record progress

1. Run checks relevant to changed behavior. Include migrations, rollback, concurrency, security, or integration checks only when applicable and safe.
2. Distinguish tests that ran from tests that remain blocked or unrun. Never claim a pass based on intent, syntax alone, or an older handoff.
3. Mark a milestone Done only after its implementation, relevant migrations, tests, and documentation are complete.
4. Update roadmap status only from verified evidence. Use Blocked only with a concrete blocker and keep normally one implementation milestone In progress.
5. Update progress with completed work, commands/results, blockers, and the next concrete task.
6. Update decisions only for accepted choices, API docs only for implemented contracts, and architecture only when the implemented design changes.

## Write the current handoff

Replace `docs/handoffs/current.md` with a concise, current record containing the milestone, Git state, completed work, next task, reading order, test/migration status, blockers, constraints, expected files, exclusions, and safe startup commands. Never include secrets, tokens, passwords, connection strings, `.env` values, or sensitive log output.

Archive a handoff only when a milestone completes, a significant architectural direction changes, or work transfers between Codex and Claude Code. Do not create an archive for every chat.

## Completion report

Report files changed, current milestone/status, verification actually run, unrun checks, blockers, Git status, and diff summary. State explicitly when no code, migration, database, dependency, commit, or push action occurred. Keep the report concise and never make a false completion claim.
