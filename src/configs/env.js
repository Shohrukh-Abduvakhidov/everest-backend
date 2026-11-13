import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { parseTrustProxy } from '../utils/trust-proxy.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(currentDirectory, '../../.env'), quiet: true });

function readString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value;
}

function readRequired(name) {
  const value = readString(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = readString(name, String(fallback));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid integer environment variable: ${name}`);
  }
  return value;
}

function readBoolean(name, fallback = false) {
  const raw = readString(name, String(fallback)).toLowerCase();
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Invalid boolean environment variable: ${name}`);
  }
  return raw === 'true';
}

function readIntegerList(name, fallback, { min = 1, max = 1000 } = {}) {
  const values = readString(name, fallback).split(',').map((value) => Number(value.trim()));
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value < min || value > max)) {
    throw new Error(`Invalid integer list environment variable: ${name}`);
  }
  return values;
}

// NCT trainer. Difficulty levels map names to ranges of questions.difficulty (1..5), e.g.
// "easy:1-2,medium:3,hard:4-5". Mixed shares follow the level order and are percentages.
function readTrainerConfig() {
  const name = 'TRAINER_DIFFICULTY_LEVELS';
  const levels = readString(name, 'easy:1-2,medium:3,hard:4-5').split(',').map((entry) => {
    const match = /^([a-z]+):([1-5])(?:-([1-5]))?$/.exec(entry.trim());
    if (!match || match[1] === 'mixed') throw new Error(`Invalid environment variable: ${name}`);
    const low = Number(match[2]);
    const high = Number(match[3] ?? match[2]);
    if (high < low) throw new Error(`Invalid environment variable: ${name}`);
    return Object.freeze({ name: match[1], min: low, max: high });
  });
  if (new Set(levels.map((level) => level.name)).size !== levels.length) {
    throw new Error(`Invalid environment variable: ${name}`);
  }
  const maxQuestions = readInteger('TRAINER_MAX_QUESTIONS', 50, { max: 200 });
  const questionCounts = readIntegerList('TRAINER_QUESTION_COUNTS', '10,20,30,50', { max: maxQuestions });
  const mixedShares = readIntegerList('TRAINER_MIXED_SHARES', '30,40,30', { min: 0, max: 100 });
  if (mixedShares.length !== levels.length || mixedShares.reduce((sum, value) => sum + value, 0) !== 100) {
    throw new Error('TRAINER_MIXED_SHARES must give one percentage per level and sum to 100');
  }
  return Object.freeze({
    bankCodePrefix: readString('TRAINER_BANK_CODE_PREFIX', 'nct-'),
    levels: Object.freeze(levels),
    questionCounts: Object.freeze(questionCounts),
    mixedShares: Object.freeze(mixedShares),
    readinessWindow: readInteger('TRAINER_READINESS_WINDOW', 5, { max: 100 }),
    weakTopicMinAnswers: readInteger('TRAINER_WEAK_TOPIC_MIN_ANSWERS', 5, { max: 1000 }),
    weakTopicsLimit: readInteger('TRAINER_WEAK_TOPICS_LIMIT', 5, { max: 50 }),
    recentResultsLimit: readInteger('TRAINER_RECENT_RESULTS_LIMIT', 5, { max: 50 }),
  });
}

export const databaseConfig = Object.freeze({
  host: readRequired('DB_HOST'),
  port: readInteger('DB_PORT', 5432, { max: 65535 }),
  database: readRequired('DB_NAME'),
  user: readRequired('DB_USER'),
  password: readRequired('DB_PASSWORD'),
  ssl: readBoolean('DB_SSL') ? { rejectUnauthorized: true } : false,
});

const nodeEnv = readString('NODE_ENV', 'development');

const env = Object.freeze({
  nodeEnv,
  // API docs are off in production unless explicitly enabled.
  swaggerEnabled: readBoolean('SWAGGER_ENABLED', nodeEnv !== 'production'),
  port: readInteger('PORT', 4000, { max: 65535 }),
  // Proxies whose X-Forwarded-For is believed when computing req.ip (rate limits, session IPs).
  trustProxy: parseTrustProxy(readString('TRUST_PROXY')),
  corsOrigins: readString('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  shutdownTimeoutMs: readInteger('SHUTDOWN_TIMEOUT_MS', 10000),
  database: databaseConfig,
  dbPoolMax: readInteger('DB_POOL_MAX', 5),
  dbConnectionTimeoutMs: readInteger('DB_CONNECTION_TIMEOUT_MS', 5000),
  dbIdleTimeoutMs: readInteger('DB_IDLE_TIMEOUT_MS', 30000),
  jwtAccessSecret: readString('JWT_ACCESS_SECRET'),
  authSessionTtlSeconds: readInteger('AUTH_SESSION_TTL_SECONDS', 900),
  authRefreshTtlSeconds: readInteger('AUTH_REFRESH_TTL_SECONDS', 2592000),
  authRateWindowSeconds: readInteger('AUTH_RATE_WINDOW_SECONDS', 900),
  authRateBlockSeconds: readInteger('AUTH_RATE_BLOCK_SECONDS', 900),
  authLoginMaxAttempts: readInteger('AUTH_LOGIN_MAX_ATTEMPTS', 5, { max: 100 }),
  authPublicRateLimit: readInteger('AUTH_PUBLIC_RATE_LIMIT', 100, { max: 10000 }),
  authAdminRateLimit: readInteger('AUTH_ADMIN_RATE_LIMIT', 100, { max: 10000 }),
  playbackRateLimit: readInteger('PLAYBACK_RATE_LIMIT', 120, { max: 10000 }),
  questionImportRateLimit: readInteger('QUESTION_IMPORT_RATE_LIMIT', 20, { max: 10000 }),
  questionImportMaxUploadBytes: readInteger('QUESTION_IMPORT_MAX_UPLOAD_MB', 256, { max: 512 }) * 1024 * 1024,
  questionImportUploadDirectory: path.resolve(
    readString('QUESTION_IMPORT_UPLOAD_DIR', path.resolve(currentDirectory, '../../uploads/question-imports')),
  ),
  questionImportUploadTtlHours: readInteger('QUESTION_IMPORT_UPLOAD_TTL_HOURS', 24, { max: 720 }),
  questionImportWorkerIntervalMs: readInteger('QUESTION_IMPORT_WORKER_INTERVAL_MS', 5000),
  attemptSweepIntervalMs: readInteger('ATTEMPT_SWEEP_INTERVAL_MS', 30000),
  trainer: readTrainerConfig(),
  progressMinIntervalSeconds: readInteger('PROGRESS_MIN_INTERVAL_SECONDS', 10, { max: 60 }),
  offline: Object.freeze({
    licenseDays: readInteger('OFFLINE_LICENSE_DAYS', 14, { max: 60 }),
    maxDevices: readInteger('OFFLINE_MAX_DEVICES', 2, { max: 10 }),
    // Content keys are derived from this secret and never stored; changing it makes every
    // downloaded copy undecryptable.
    keySecret: readString('OFFLINE_KEY_SECRET'),
  }),
  otpHmacSecret: readString('OTP_HMAC_SECRET'),
  recoveryChallengeTtlSeconds: readInteger('RECOVERY_CHALLENGE_TTL_SECONDS', 600),
  recoveryResetTtlSeconds: readInteger('RECOVERY_RESET_TTL_SECONDS', 600),
  recoveryResendCooldownSeconds: readInteger('RECOVERY_RESEND_COOLDOWN_SECONDS', 60),
  recoveryMaxAttempts: readInteger('RECOVERY_MAX_ATTEMPTS', 5, { max: 20 }),
  recoveryMaxRequestsPerHour: readInteger('RECOVERY_MAX_REQUESTS_PER_HOUR', 5, { max: 100 }),
  telegramOidcStateTtlSeconds: readInteger('TELEGRAM_OIDC_STATE_TTL_SECONDS', 600),
  storage: Object.freeze({
    endpoint: readString('S3_ENDPOINT'),
    publicEndpoint: readString('S3_PUBLIC_ENDPOINT'),
    region: readString('S3_REGION', 'us-east-1'),
    bucket: readString('S3_BUCKET'),
    accessKeyId: readString('S3_ACCESS_KEY_ID'),
    secretAccessKey: readString('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: readBoolean('S3_FORCE_PATH_STYLE', true),
    partSizeBytes: readInteger('STORAGE_PART_SIZE_BYTES', 32 * 1024 * 1024, {
      min: 5 * 1024 * 1024,
      max: 5 * 1024 * 1024 * 1024,
    }),
    // Part URLs live an hour, so a long upload on a slow line does not lose its links.
    presignTtlSeconds: readInteger('STORAGE_PRESIGN_TTL_SECONDS', 3600, { min: 60, max: 3600 }),
    // Below the 3-day AbortIncompleteMultipartUpload rule applied by storage:configure.
    uploadTtlHours: readInteger('STORAGE_UPLOAD_TTL_HOURS', 48, { max: 70 }),
    videoMaxBytes: readInteger('VIDEO_MAX_BYTES', 4 * 1024 * 1024 * 1024, { max: 20 * 1024 * 1024 * 1024 }),
    // The whole video library (ready videos plus open video uploads); the disk is shared.
    videoTotalQuotaBytes: readInteger('VIDEO_TOTAL_QUOTA_BYTES', 15 * 1024 * 1024 * 1024),
    maxActiveVideoUploads: readInteger('VIDEO_MAX_ACTIVE_UPLOADS', 3, { max: 50 }),
    // Playback URLs are signed at the start of a fixed window, so every request inside the
    // window gets the same URL (browser cache); a URL lives window + this TTL.
    playbackUrlTtlSeconds: readInteger('VIDEO_PLAYBACK_URL_TTL_SECONDS', 7200, { min: 60, max: 43200 }),
    playbackUrlWindowSeconds: readInteger('VIDEO_PLAYBACK_URL_WINDOW_SECONDS', 21600, { min: 60, max: 86400 }),
    uploadSweepIntervalMs: readInteger('UPLOAD_SWEEP_INTERVAL_MS', 600000),
  }),
  telegram: Object.freeze({
    discoveryUrl: 'https://oauth.telegram.org/.well-known/openid-configuration',
    clientId: readString('TELEGRAM_CLIENT_ID'),
    clientSecret: readString('TELEGRAM_CLIENT_SECRET'),
    redirectUri: readString('TELEGRAM_REDIRECT_URI'),
    botUsername: readString('TELEGRAM_BOT_USERNAME'),
    botToken: readString('TELEGRAM_BOT_TOKEN'),
    webhookSecret: readString('TELEGRAM_WEBHOOK_SECRET'),
  }),
});

export default env;
