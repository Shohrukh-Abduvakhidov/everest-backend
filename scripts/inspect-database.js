import pg from 'pg';

import env from '../src/configs/env.js';

const { Client } = pg;
const client = new Client(env.database);

try {
  await client.connect();
  const catalog = await client.query(`
    SELECT
      current_database() AS database_name,
      current_setting('server_version') AS server_version,
      (
        SELECT count(*)::integer
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name <> 'pgmigrations'
      ) AS application_tables,
      to_regclass('public.pgmigrations') IS NOT NULL AS has_migration_history
  `);

  const result = catalog.rows[0];
  const output = {
    host: env.database.host,
    port: env.database.port,
    database: result.database_name,
    user: env.database.user,
    serverVersion: result.server_version,
    applicationTables: result.application_tables,
    hasMigrationHistory: result.has_migration_history,
  };

  const tables = await client.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  output.tableRowCounts = {};
  for (const { tablename } of tables.rows) {
    const quotedTable = `"${tablename.replaceAll('"', '""')}"`;
    const count = await client.query(`SELECT count(*)::text AS count FROM ${quotedTable}`);
    output.tableRowCounts[tablename] = count.rows[0].count;
  }

  if (result.has_migration_history) {
    const migrations = await client.query('SELECT name FROM pgmigrations ORDER BY id');
    output.appliedMigrations = migrations.rows.map((row) => row.name);
  }

  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error('Database inspection failed', { code: error.code, message: error.message });
  process.exitCode = 1;
} finally {
  await client.end();
}
