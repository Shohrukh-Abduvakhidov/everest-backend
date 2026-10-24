import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(projectRoot, 'src', 'migrations');
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith('.js'))
  .sort();
const baselineMigrationFiles = migrationFiles.filter((name) => name.startsWith('1761264000'));

const upSections = [];
const downSections = [];

for (const filename of baselineMigrationFiles) {
  const migration = await import(pathToFileURL(path.join(migrationsDirectory, filename)));
  migration.up({ sql: (sql) => upSections.push(sql.trim()) });
  migration.down({ sql: (sql) => downSections.push(sql.trim()) });
}

const document = await readFile(path.join(projectRoot, 'schema_tables.md'), 'utf8');
const sqlStart = document.indexOf('CREATE TABLE users (');
const sqlEnd = document.indexOf('\n```', sqlStart);
const expectedSql = document.slice(sqlStart, sqlEnd).trim();
const actualSql = upSections.join('\n\n');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const summary = {
  baselineMigrations: baselineMigrationFiles.length,
  totalMigrations: migrationFiles.length,
  baselineMatches: actualSql === expectedSql,
  expectedSha256: digest(expectedSql),
  actualSha256: digest(actualSql),
  tables: (actualSql.match(/^CREATE TABLE /gm) || []).length,
  functions: (actualSql.match(/^CREATE (?:OR REPLACE )?FUNCTION /gm) || []).length,
  triggers: (actualSql.match(/^CREATE TRIGGER /gm) || []).length,
  explicitIndexes: (actualSql.match(/^CREATE (?:UNIQUE )?INDEX /gm) || []).length,
  roleSeeds: (actualSql.match(/^ \('00000000-0000-4000-8000-00000000000[1-4]'/gm) || []).length,
  downUsesCascade: downSections.some((sql) => /\bCASCADE\b/i.test(sql)),
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.baselineMatches || summary.baselineMigrations !== 12
  || summary.tables !== 81 || summary.functions !== 7
  || summary.triggers !== 11 || summary.roleSeeds !== 4 || summary.downUsesCascade) {
  process.exitCode = 1;
}
