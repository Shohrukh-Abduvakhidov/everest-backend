# M04-B completion — group administration and announcements

M04-B implemented permission-protected group create/update, active student membership lifecycle, teacher assignment, and text-only group announcements.

The reversible `20261027010000000_add-group-management-permissions.js` migration seeds five actions. Owner/admin receive all group-management actions. Teachers receive only announcement management, and runtime scope additionally requires assignment to the target group with publishing enabled.

Membership removal retains the unique membership row as `removed`; re-addition reactivates it. Teacher removal deletes the assignment because the published schema has no assignment lifecycle column. Announcement deletion archives its row. Every successful mutation and audit event shares one service-owned transaction. No route creates course enrollment, module access, attachments, progress, ranking, or `group_courses`.

Verification on 27 October 2026:

- focused M04-B integration: nine subtests passed;
- full `npm test`: 91 tests plus source integrity, eight schema constraints, and server lifecycle passed;
- `npm run migrate:up`: no-op after applying the migration;
- disposable migration cycle: 17 → 17 → 16 → 17, database removed;
- catalog: 85 tables, 668 columns, 159 foreign keys, 301 indexes, 17 migrations, 65 identity columns;
- SQL and transaction boundary scans, ESM scan, and `git diff --check`: passed.

Next milestone: M05 course management.
