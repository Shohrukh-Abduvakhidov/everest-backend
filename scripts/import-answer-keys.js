import { writeFile } from 'node:fs/promises';

import pool from '../src/configs/db.js';
import {
  dryRunAnswerKeyImportService,
  runAnswerKeyImportService,
} from '../src/services/answer-key-import-service.js';
import { resolveImportActorService } from '../src/services/question-import-service.js';
import { loadAnswerKeyFile } from '../src/utils/answer-key-file.js';

// Usage:
//   npm run import:answer-keys -- --keys <file.json> --actor-phone +992... [--bank <code>]
//     [--dry-run] [--idempotency-key <key>] [--batch-size <1-100>] [--report <file.json>]
//     [--set-matching-rules | --set-allow-right-reuse-false]
// Exit codes: 0 success, 1 failure, 2 file rejected by validation.
// Output contains counts and codes only; answer data and question text are never printed.
// The --report file contains per-record outcomes, including both keys of a KEY_CONFLICT.

const usage = 'Usage: npm run import:answer-keys -- --keys <file.json> --actor-phone +992... '
  + '[--bank <code>] [--dry-run] [--idempotency-key <key>] [--batch-size <n>] [--report <file>] '
  + '[--set-matching-rules]';

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
    if (name === '--keys') options.keysPath = value();
    else if (name === '--actor-phone') options.actorPhone = value();
    else if (name === '--bank') options.bankCode = value();
    else if (name === '--idempotency-key') options.idempotencyKey = value();
    else if (name === '--batch-size') options.batchSize = Number(value());
    else if (name === '--report') options.reportPath = value();
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--set-matching-rules' || name === '--set-allow-right-reuse-false') {
      options.setMatchingRules = true;
    } else throw new Error(`Unknown argument ${name}. ${usage}`);
  }
  if (!options.keysPath || !options.actorPhone) throw new Error(usage);
  return options;
}

function summary(result) {
  return {
    mode: result.mode,
    status: result.status ?? (result.valid ? 'valid' : 'invalid'),
    replayed: result.replayed ?? false,
    runId: result.runId ?? null,
    previousRunId: result.previousRunId ?? null,
    bankCode: result.bankCode,
    fileSha256: result.fileSha256,
    idempotencyKey: result.idempotencyKey,
    counters: result.counters,
    topOutcomeCodes: result.topOutcomeCodes ?? [],
    firstErrors: (result.errors ?? []).slice(0, 20).map(({ code, path, externalId, message }) => ({
      code, path, externalId, message,
    })),
  };
}

try {
  const options = readArguments(process.argv.slice(2));
  const keyFile = await loadAnswerKeyFile(options.keysPath);
  const actorId = await resolveImportActorService(options.actorPhone);
  const serviceOptions = {
    bankCode: options.bankCode,
    idempotencyKey: options.idempotencyKey,
    batchSize: options.batchSize,
    setMatchingRules: options.setMatchingRules,
  };
  const result = options.dryRun
    ? await dryRunAnswerKeyImportService(actorId, keyFile, serviceOptions)
    : await runAnswerKeyImportService(actorId, keyFile, serviceOptions, {
      log: (message, details) => console.error(message, details),
    });
  if (options.reportPath) await writeFile(options.reportPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(summary(result), null, 2));
  if (result.valid === false || result.status === 'rejected') process.exitCode = 2;
  else if (result.status === 'failed') process.exitCode = 1;
} catch (error) {
  console.error('Answer-key import failed', {
    code: error.code || 'IMPORT_FAILED',
    message: error.message,
    details: error.details,
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
