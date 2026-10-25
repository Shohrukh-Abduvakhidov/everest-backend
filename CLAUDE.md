@AGENTS.md

# Claude Code Adapter

Follow `AGENTS.md`, including its startup and completion protocols and mandatory repositories layer. At startup, inspect Git state and recent commits, then read `ROADMAP.md`, `docs/handoffs/current.md`, `docs/architecture.md`, `docs/progress.md`, and `docs/decisions.md` before inspecting the selected milestone's code.

Continue the existing Codex implementation in this repository. Inspect git status/diff and applied migrations before editing; do not reinitialize the backend or repeat completed changes.

Use the applicable project skills under `.claude/skills/`; their portable counterparts must match `.agents/skills/`. Update `docs/handoffs/current.md` before ending a work session.

Keep architectural rules in AGENTS.md and documentation.md. This file is only an adapter, not a second source of business or coding conventions.

Never change an applied migration, commit secrets, or run `migrate:down` against `everest_db`.
