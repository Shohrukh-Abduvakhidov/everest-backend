// Teachers may grant extra attempts; the SQL scope limits them to assignments made to a group
// they teach with can_view_results. Only this role binding is added and removed.
export const up = pgm => {
  pgm.sql(`
INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code = 'teacher' AND permission.code = 'tests.attempts.grant';
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE code = 'teacher')
  AND permission_id = (SELECT id FROM permissions WHERE code = 'tests.attempts.grant');
  `)
}
