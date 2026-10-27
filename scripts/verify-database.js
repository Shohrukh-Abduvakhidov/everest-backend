import pg from 'pg';

import env from '../src/configs/env.js';

const { Client } = pg;
const client = new Client(env.database);

const expected = {
  tables: 85,
  columns: 668,
  foreignKeys: 159,
  indexes: 301,
  functions: 7,
  triggers: 11,
  roles: 4,
  migrations: 17,
  identityColumns: 65,
};

try {
  await client.connect();
  const result = await client.query(`
    SELECT
      (SELECT count(*)::integer FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name <> 'pgmigrations') AS tables,
      (SELECT count(*)::integer FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> 'pgmigrations') AS columns,
      (SELECT count(*)::integer FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'f') AS foreign_keys,
      (SELECT count(*)::integer FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> 'pgmigrations') AS indexes,
      (SELECT count(*)::integer FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f') AS functions,
      (SELECT count(*)::integer FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
      (SELECT count(*)::integer FROM roles
        WHERE code IN ('owner', 'admin', 'teacher', 'student')) AS roles,
      (SELECT count(*)::integer FROM pgmigrations) AS migrations,
      (SELECT count(*)::integer FROM information_schema.columns
        WHERE table_schema = 'public' AND is_identity = 'YES') AS identity_columns
  `);

  const row = result.rows[0];
  const actual = {
    tables: row.tables,
    columns: row.columns,
    foreignKeys: row.foreign_keys,
    indexes: row.indexes,
    functions: row.functions,
    triggers: row.triggers,
    roles: row.roles,
    migrations: row.migrations,
    identityColumns: row.identity_columns,
  };

  const forbidden = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('group_courses', 'question_versions')
  `);
  const uuidKeys = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns AS column_info
    WHERE table_schema = 'public'
      AND data_type = 'uuid'
      AND EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_info
        JOIN unnest(constraint_info.conkey) AS key(attnum) ON TRUE
        JOIN pg_class AS relation ON relation.oid = constraint_info.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
        WHERE namespace.nspname = 'public'
          AND relation.relname = column_info.table_name
          AND attribute.attname = column_info.column_name
          AND constraint_info.contype IN ('p', 'f')
      )
  `);
  const invalidEntityIds = await client.query(`
    SELECT table_name, data_type, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name <> 'pgmigrations'
      AND column_name = 'id'
      AND (data_type <> 'bigint' OR is_identity <> 'YES')
    ORDER BY table_name
  `);
  const invalidForeignKeys = await client.query(`
    SELECT DISTINCT relation.relname AS table_name, attribute.attname AS column_name,
      format_type(attribute.atttypid, attribute.atttypmod) AS data_type
    FROM pg_constraint AS constraint_info
    JOIN pg_class AS relation ON relation.oid = constraint_info.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN unnest(constraint_info.conkey) AS key(attnum) ON TRUE
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
    WHERE namespace.nspname = 'public'
      AND constraint_info.contype = 'f'
      AND format_type(attribute.atttypid, attribute.atttypmod) <> 'bigint'
    ORDER BY relation.relname, attribute.attname
  `);
  const remainingUuidColumns = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'uuid'
    ORDER BY table_name, column_name
  `);
  const authorizationSeeds = await client.query(`
    SELECT
      (SELECT count(*)::integer FROM permissions) AS permissions,
      (SELECT count(*)::integer FROM role_permissions) AS role_permissions,
      (SELECT count(*)::integer
       FROM role_permissions AS grant_record
       JOIN roles AS role ON role.id = grant_record.role_id
       WHERE role.code = 'teacher') AS teacher_grants,
      (SELECT count(*)::integer
       FROM role_permissions AS grant_record
       JOIN roles AS role ON role.id = grant_record.role_id
       WHERE role.code = 'student') AS student_grants
  `);

  let permissionConstraintCode = null;
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO permissions (code, description) VALUES ('accountsXinvalid', 'invalid')`
    );
  } catch (error) {
    permissionConstraintCode = error.code;
  }
  await client.query('ROLLBACK');

  await client.query('BEGIN');
  const generated = await client.query(
    "INSERT INTO users (status) VALUES ('pending') RETURNING id, pg_typeof(id)::text AS type"
  );
  await client.query('ROLLBACK');
  const generatedIdentity = generated.rows[0];
  const valid = Object.entries(expected).every(([key, value]) => actual[key] === value)
    && forbidden.rowCount === 0
    && uuidKeys.rowCount === 0
    && invalidEntityIds.rowCount === 0
    && invalidForeignKeys.rowCount === 0
    && remainingUuidColumns.rowCount === 1
    && remainingUuidColumns.rows[0].table_name === 'sms_deliveries'
    && remainingUuidColumns.rows[0].column_name === 'idempotency_key'
    && authorizationSeeds.rows[0].permissions === 10
    && authorizationSeeds.rows[0].role_permissions === 21
    && authorizationSeeds.rows[0].teacher_grants === 1
    && authorizationSeeds.rows[0].student_grants === 0
    && permissionConstraintCode === '23514'
    && generatedIdentity.type === 'bigint'
    && /^[1-9][0-9]*$/.test(generatedIdentity.id);

  console.log(JSON.stringify({
    database: env.database.database,
    expected,
    actual,
    forbiddenTables: forbidden.rows.map((rowValue) => rowValue.table_name),
    uuidPrimaryOrForeignKeys: uuidKeys.rows,
    invalidEntityIds: invalidEntityIds.rows,
    invalidForeignKeys: invalidForeignKeys.rows,
    remainingUuidColumns: remainingUuidColumns.rows,
    authorizationSeeds: authorizationSeeds.rows[0],
    permissionConstraintCode,
    generatedIdentity,
    valid,
  }, null, 2));

  if (!valid) process.exitCode = 1;
} catch (error) {
  console.error('Database verification failed', { code: error.code, message: error.message });
  process.exitCode = 1;
} finally {
  await client.end();
}
