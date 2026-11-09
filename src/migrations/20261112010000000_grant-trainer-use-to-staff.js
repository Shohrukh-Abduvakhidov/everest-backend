// Administrators and owners may use the NCT trainer like students: the same routes, their own
// trainings, overview and history. Teachers stay without it. Only the role bindings are added
// and removed. Idempotent: a missing role or permission inserts nothing, and a repeat is a no-op.
export const up = pgm => {
   pgm.sql(`
INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code IN ('admin', 'owner') AND permission.code = 'trainer.use'
ON CONFLICT DO NOTHING;
   `)
}

export const down = pgm => {
   pgm.sql(`
DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE code IN ('admin', 'owner'))
  AND permission_id = (SELECT id FROM permissions WHERE code = 'trainer.use');
   `)
}
