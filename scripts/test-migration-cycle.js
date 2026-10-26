import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import env from '../src/configs/env.js';

const { Client } = pg;
const databaseName = `everest_migration_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

if (!/^everest_migration_test_[a-f0-9]{12}$/.test(databaseName)) {
  throw new Error('Generated disposable database name failed validation');
}

const maintenanceClient = new Client({ ...env.database, database: 'postgres' });

function runMigration(direction) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/configs/migrate.js', direction], {
      cwd: process.cwd(),
      env: { ...process.env, DB_NAME: databaseName },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Migration ${direction} exited with code ${code}`));
    });
  });
}

async function readState() {
  const client = new Client({ ...env.database, database: databaseName });
  try {
    await client.connect();
    const result = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM pgmigrations) AS migrations,
        (SELECT count(*)::integer FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            AND table_name <> 'pgmigrations') AS tables,
        (SELECT count(*)::integer FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prokind = 'f') AS functions
    `);
    return result.rows[0];
  } finally {
    await client.end();
  }
}

try {
  await maintenanceClient.connect();
  await maintenanceClient.query(`CREATE DATABASE "${databaseName}"`);
  console.log('Created disposable migration database', { database: databaseName });

  await runMigration('up');
  const afterUp = await readState();
  if (afterUp.migrations !== 15 || afterUp.tables !== 84 || afterUp.functions !== 7) {
    throw new Error(`Unexpected state after up: ${JSON.stringify(afterUp)}`);
  }

  await runMigration('up');
  const afterNoOpUp = await readState();
  if (afterNoOpUp.migrations !== 15) {
    throw new Error(`Second up was not a no-op: ${JSON.stringify(afterNoOpUp)}`);
  }

  await runMigration('down');
  const afterDown = await readState();
  if (afterDown.migrations !== 14 || afterDown.tables !== 82 || afterDown.functions !== 7) {
    throw new Error(`Down did not roll back exactly one migration: ${JSON.stringify(afterDown)}`);
  }

  await runMigration('up');
  const afterReapply = await readState();
  if (afterReapply.migrations !== 15 || afterReapply.tables !== 84
      || afterReapply.functions !== 7) {
    throw new Error(`Reapply did not restore the migration: ${JSON.stringify(afterReapply)}`);
  }

  console.log(JSON.stringify({ afterUp, afterNoOpUp, afterDown, afterReapply }, null, 2));
} catch (error) {
  console.error('Disposable migration cycle failed', { code: error.code, message: error.message });
  process.exitCode = 1;
} finally {
  try {
    await maintenanceClient.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    console.log('Dropped disposable migration database', { database: databaseName });
  } catch (error) {
    console.error('Failed to drop disposable migration database', {
      code: error.code,
      database: databaseName,
    });
    process.exitCode = 1;
  }
  await maintenanceClient.end();
}
