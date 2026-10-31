import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import env from '../src/configs/env.js';

// Runs the node:test suite against a freshly migrated disposable database, so results never
// depend on rows in the developer database (DB_NAME). The configured database is not touched:
// only CREATE DATABASE / DROP DATABASE on the generated name run through the maintenance
// connection. dotenv does not override variables that are already set, so the child
// processes receive the disposable DB_NAME.

const { Client } = pg;
const databaseName = `everest_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

if (!/^everest_test_[a-f0-9]{12}$/.test(databaseName)) {
  throw new Error('Generated disposable database name failed validation');
}

const maintenanceClient = new Client({ ...env.database, database: 'postgres' });
const childEnv = { ...process.env, DB_NAME: databaseName };

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: childEnv, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

let created = false;
try {
  await maintenanceClient.connect();
  await maintenanceClient.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  console.log('Created disposable test database', { database: databaseName });
  if (await run(['src/configs/migrate.js', 'up']) !== 0) throw new Error('Migrations failed');
  process.exitCode = await run(['--test', '--test-concurrency=1', ...process.argv.slice(2), 'tests/all.test.js']);
} catch (error) {
  console.error('Disposable test run failed', { code: error.code, message: error.message });
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await maintenanceClient.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      console.log('Dropped disposable test database', { database: databaseName });
    } catch (error) {
      console.error('Failed to drop disposable test database', { code: error.code, database: databaseName });
      process.exitCode = 1;
    }
  }
  await maintenanceClient.end();
}
