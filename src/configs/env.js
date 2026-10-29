import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

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

export const databaseConfig = Object.freeze({
  host: readRequired('DB_HOST'),
  port: readInteger('DB_PORT', 5432, { max: 65535 }),
  database: readRequired('DB_NAME'),
  user: readRequired('DB_USER'),
  password: readRequired('DB_PASSWORD'),
  ssl: readBoolean('DB_SSL') ? { rejectUnauthorized: true } : false,
});

const env = Object.freeze({
  nodeEnv: readString('NODE_ENV', 'development'),
  port: readInteger('PORT', 4000, { max: 65535 }),
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
    presignTtlSeconds: readInteger('STORAGE_PRESIGN_TTL_SECONDS', 900, { min: 60, max: 3600 }),
    uploadTtlHours: readInteger('STORAGE_UPLOAD_TTL_HOURS', 144, { max: 166 }),
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
