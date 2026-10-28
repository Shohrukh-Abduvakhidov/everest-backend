# M05-A completion — course catalog, lifecycle and teacher assignments

M05-A implemented administrative course list/detail/create/update, explicit publish/unpublish commands, and course teacher assignment management.

The reversible `20261027020000000_add-course-management-permissions.js` migration adds `course_teachers.can_edit_course` and five action permissions. Owner/admin receive all five. Teachers receive read/update actions, while target-course assignment and the explicit edit flag enforce resource scope. Publication and teacher management remain owner/admin-only.

Course fields are limited to subject, title, description, primary language, translation dictionary, and optional existing cover asset. General PATCH cannot set creator or status. Publication locks the course and requires title plus subject. Archived is a schema state but has no M05-A transition route. Teacher assignment does not create enrollment, module access, group relationships, modules, lessons, preview, copying, or uploads.

Verification on 27 October 2026:

- focused M05-A integration: ten subtests passed;
- full `npm test`: 102 tests plus source integrity, eight schema constraints, and server lifecycle passed;
- `npm run migrate:up`: no-op after applying the migration;
- disposable migration cycle: 18 → 18 → 17 → 18, database removed;
- catalog: 85 tables, 669 columns, 159 foreign keys, 301 indexes, 18 migrations, 65 identity columns;
- syntax, ESM, SQL and transaction boundary scans plus `git diff --check`: passed.

Next milestone: M05-B modules, ordering, preview, and course copying.
