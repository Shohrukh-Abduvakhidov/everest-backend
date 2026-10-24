import pg from 'pg';

import env from '../src/configs/env.js';

const { Client } = pg;
const client = new Client(env.database);

const expected = {
  tables: 82,
  columns: 650,
  foreignKeys: 157,
  indexes: 293,
  functions: 7,
  triggers: 11,
  roles: 4,
  migrations: 13,
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
        WHERE (id, code) IN (
          ('00000000-0000-4000-8000-000000000001'::uuid, 'owner'),
          ('00000000-0000-4000-8000-000000000002'::uuid, 'admin'),
          ('00000000-0000-4000-8000-000000000003'::uuid, 'teacher'),
          ('00000000-0000-4000-8000-000000000004'::uuid, 'student')
        )) AS roles,
      (SELECT count(*)::integer FROM pgmigrations) AS migrations
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
  };

  const forbidden = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('group_courses', 'question_versions')
  `);
  const valid = Object.entries(expected).every(([key, value]) => actual[key] === value)
    && forbidden.rowCount === 0;

  console.log(JSON.stringify({
    database: env.database.database,
    expected,
    actual,
    forbiddenTables: forbidden.rows.map((rowValue) => rowValue.table_name),
    valid,
  }, null, 2));

  if (!valid) process.exitCode = 1;
} catch (error) {
  console.error('Database verification failed', { code: error.code, message: error.message });
  process.exitCode = 1;
} finally {
  await client.end();
}
