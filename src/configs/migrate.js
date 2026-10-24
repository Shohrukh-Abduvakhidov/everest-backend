import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';

import env from './env.js';

const direction = process.argv[2] || 'up';

if (!['up', 'down'].includes(direction)) {
  throw new Error('Migration direction must be up or down');
}

const disposableNamePattern = /(?:^|_)(?:test|tmp|temp|disposable)(?:_|$)/i;
if (direction === 'down' && !disposableNamePattern.test(env.database.database)) {
  throw new Error('Down migrations are allowed only for clearly named disposable databases');
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

console.log('Migration target', {
  host: env.database.host,
  port: env.database.port,
  database: env.database.database,
  direction,
});

try {
  await runner({
    databaseUrl: env.database,
    dir: path.resolve(currentDirectory, '../migrations'),
    direction,
    migrationsTable: 'pgmigrations',
    count: direction === 'down' ? 1 : Infinity,
    checkOrder: true,
    lock: true,
    singleTransaction: true,
    verbose: false,
  });
} catch (error) {
  console.error('Migration command failed', { code: error.code, message: error.message });
  process.exitCode = 1;
}
