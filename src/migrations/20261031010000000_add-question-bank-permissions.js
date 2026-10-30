export const up = pgm => {
  pgm.sql(`
ALTER TABLE question_answer_keys ADD CONSTRAINT question_answer_keys_verified_source_check
    CHECK (status <> 'verified' OR source IN ('official_key', 'expert_review'));

INSERT INTO permissions (code, description) VALUES
    ('taxonomy.read', 'Read subjects, sections and topics'),
    ('taxonomy.manage', 'Create, edit and delete subjects, sections and topics'),
    ('questions.read', 'Read own and staff-visible question banks'),
    ('questions.manage', 'Create question banks and author draft questions in own banks'),
    ('questions.review', 'Verify answer keys, publish and archive questions');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE (
    role.code IN ('owner', 'admin')
    AND permission.code IN (
        'taxonomy.read', 'taxonomy.manage', 'questions.read', 'questions.manage', 'questions.review'
    )
) OR (
    role.code = 'teacher'
    AND permission.code IN ('taxonomy.read', 'questions.read', 'questions.manage')
);
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions
    WHERE code IN (
        'taxonomy.read', 'taxonomy.manage', 'questions.read', 'questions.manage', 'questions.review'
    )
);

DELETE FROM permissions
WHERE code IN (
    'taxonomy.read', 'taxonomy.manage', 'questions.read', 'questions.manage', 'questions.review'
);

ALTER TABLE question_answer_keys DROP CONSTRAINT question_answer_keys_verified_source_check;
  `)
}
