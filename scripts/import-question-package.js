import { writeFile } from 'node:fs/promises';

import pool from '../src/configs/db.js';
import {
  dryRunQuestionImportService,
  resolveImportActorService,
  runQuestionImportService,
} from '../src/services/question-import-service.js';
import { loadQuestionPackage } from '../src/utils/question-package.js';

// Usage:
//   npm run import:questions -- --package <dir|zip> --actor-phone +992... [--dry-run]
//     [--idempotency-key <key>] [--batch-size <1-100>] [--report <file.json>]
// Exit codes: 0 success, 1 failure, 2 package rejected by validation.
// Output contains counts, codes and record paths only; question text is never printed.

const usage = 'Usage: npm run import:questions -- --package <path> --actor-phone +992... '
  + '[--dry-run] [--idempotency-key <key>] [--batch-size <n>] [--report <file>]';

function readArguments(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value. ${usage}`);
      index += 1;
      return next;
    };
    if (name === '--package') options.packagePath = value();
    else if (name === '--actor-phone') options.actorPhone = value();
    else if (name === '--idempotency-key') options.idempotencyKey = value();
    else if (name === '--batch-size') options.batchSize = Number(value());
    else if (name === '--report') options.reportPath = value();
    else if (name === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument ${name}. ${usage}`);
  }
  if (!options.packagePath || !options.actorPhone) throw new Error(usage);
  return options;
}

function summary(result) {
  return {
    mode: result.mode,
    status: result.status ?? (result.valid ? 'valid' : 'invalid'),
    replayed: result.replayed ?? false,
    runId: result.runId ?? result.run?.id ?? null,
    packageSha256: result.packageSha256 ?? result.run?.packageSha256,
    idempotencyKey: result.idempotencyKey ?? result.run?.idempotencyKey,
    counters: result.counters ?? result.run?.counters,
    topErrorCodes: result.topErrorCodes ?? [],
    topWarningCodes: result.topWarningCodes ?? [],
    firstErrors: (result.errors ?? []).slice(0, 20).map(({ code, path, externalId, message }) => ({
      code, path, externalId, message,
    })),
  };
}

try {
  const options = readArguments(process.argv.slice(2));
  const pkg = await loadQuestionPackage(options.packagePath);
  const actorId = await resolveImportActorService(options.actorPhone);
  const serviceOptions = { idempotencyKey: options.idempotencyKey, batchSize: options.batchSize };
  const result = options.dryRun
    ? await dryRunQuestionImportService(actorId, pkg, serviceOptions)
    : await runQuestionImportService(actorId, pkg, serviceOptions, {
      log: (message, details) => console.error(message, details),
    });
  if (options.reportPath) await writeFile(options.reportPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(summary(result), null, 2));
  if (result.valid === false || result.status === 'rejected') process.exitCode = 2;
  else if (result.status === 'failed' || result.run?.status === 'failed') process.exitCode = 1;
} catch (error) {
  console.error('Question import failed', {
    code: error.code || 'IMPORT_FAILED',
    message: error.message,
    details: error.details,
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
