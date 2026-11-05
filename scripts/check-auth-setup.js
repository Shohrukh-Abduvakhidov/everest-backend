import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

// Read-only login diagnostic. Prints pass/fail lines, never secret values, phone hashes or
// password data. Database access runs inside a READ ONLY transaction that is rolled back.
// Usage: node scripts/check-auth-setup.js [--phone +992900000001]

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const minimumSecretLength = 32
const passwordHashPrefix = 'scrypt$16384$8$1$'

let failures = 0

function report(passed, label, detail = '') {
   if (!passed) failures += 1
   console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`)
}

function info(label) {
   console.log(`INFO  ${label}`)
}

function readPhone(argv) {
   const index = argv.indexOf('--phone')
   return index >= 0 ? argv[index + 1] : '+992900000001'
}

async function loadEnv() {
   try {
      const module = await import('../src/configs/env.js')
      return module.default
   } catch (error) {
      report(false, 'configuration loads', error.message)
      return null
   }
}

function checkSecrets(env) {
   for (const [name, value] of [
      ['JWT_ACCESS_SECRET', env.jwtAccessSecret],
      ['OTP_HMAC_SECRET', env.otpHmacSecret],
   ]) {
      report(
         typeof value === 'string' && value.length >= minimumSecretLength,
         `${name} has at least ${minimumSecretLength} characters`,
      )
   }
   report(env.jwtAccessSecret !== env.otpHmacSecret, 'JWT_ACCESS_SECRET and OTP_HMAC_SECRET differ')
   report(env.corsOrigins.length > 0, 'CORS_ORIGINS has at least one origin', env.corsOrigins.join(', '))
   for (const origin of env.corsOrigins) {
      report(/^https?:\/\/[^/\s]+$/.test(origin), `CORS origin has no path or trailing slash: ${origin}`)
   }
   info(`NODE_ENV=${env.nodeEnv}; auth cookies Secure=${env.nodeEnv === 'production'}`)
}

async function checkApi(env) {
   for (const route of ['health', 'ready']) {
      try {
         const response = await fetch(`http://localhost:${env.port}/api/v1/${route}`)
         report(response.ok, `GET /api/v1/${route} on port ${env.port}`, `status ${response.status}`)
      } catch (error) {
         report(false, `GET /api/v1/${route} on port ${env.port}`, error.cause?.code || 'unreachable')
      }
   }
}

async function checkMigrations(client) {
   const files = (await readdir(path.resolve(scriptDirectory, '../src/migrations')))
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.slice(0, -3))
   const history = await client.query('SELECT name FROM pgmigrations')
   const applied = new Set(history.rows.map((row) => row.name))
   const missing = files.filter((name) => !applied.has(name))
   report(
      missing.length === 0,
      'all migrations applied',
      `${applied.size} applied, ${files.length} files${missing.length ? `; missing: ${missing.join(', ')}` : ''}`,
   )
}

async function checkAccount(client, phone) {
   const accounts = await client.query(
      `SELECT users.status, password.password_hash LIKE $2 AS hash_supported,
              password.user_id IS NOT NULL AS has_password,
              COALESCE(
                 (SELECT array_agg(roles.code::text ORDER BY roles.code)
                  FROM user_roles JOIN roles ON roles.id = user_roles.role_id
                  WHERE user_roles.user_id = users.id),
                 '{}'
              ) AS roles
       FROM user_phones AS phones
       JOIN users ON users.id = phones.user_id
       LEFT JOIN user_passwords AS password ON password.user_id = users.id
       WHERE phones.phone_e164 = $1`,
      [phone, `${passwordHashPrefix}%`],
   )
   const account = accounts.rows[0]
   report(Boolean(account), `account exists for ${phone}`)
   if (!account) return
   report(account.status === 'active', 'account is active', `status ${account.status}`)
   report(account.has_password, 'account has a password row')
   report(account.hash_supported === true, 'password hash format is supported')
   info(`roles: ${account.roles.join(', ') || 'none'}`)
}

async function checkCounters(client) {
   const counters = await client.query(
      `SELECT scope, count(*)::integer AS total,
              count(*) FILTER (WHERE blocked_until > CURRENT_TIMESTAMP)::integer AS blocked
       FROM auth_security_counters GROUP BY scope ORDER BY scope`,
   )
   const blocked = counters.rows.filter((row) => row.blocked > 0)
   report(
      blocked.length === 0,
      'no active rate-limit blocks',
      blocked.map((row) => `${row.scope}: ${row.blocked}`).join(', '),
   )
   info(`counter rows: ${counters.rows.map((row) => `${row.scope}=${row.total}`).join(', ') || 'none'}`)
}

async function checkClock(client) {
   const clock = await client.query(
      'SELECT EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::float8 AS epoch, current_setting(\'TimeZone\') AS zone',
   )
   const skewSeconds = Math.abs(Date.now() / 1000 - clock.rows[0].epoch)
   report(skewSeconds < 60, 'database and process clocks agree', `skew ${skewSeconds.toFixed(1)}s, zone ${clock.rows[0].zone}`)
}

async function checkDatabase(env, phone) {
   info(`database ${env.database.database} at ${env.database.host}:${env.database.port}`)
   const client = new pg.Client(env.database)
   try {
      await client.connect()
      report(true, 'database connection')
      await client.query('BEGIN READ ONLY')
      await checkClock(client)
      await checkMigrations(client)
      await checkAccount(client, phone)
      await checkCounters(client)
      await client.query('ROLLBACK')
   } catch (error) {
      report(false, 'database checks', error.code || error.message)
   } finally {
      await client.end().catch(() => {})
   }
}

const env = await loadEnv()
if (env?.nodeEnv === 'production') {
   console.error('Refusing to run with NODE_ENV=production')
   process.exitCode = 1
} else if (env) {
   checkSecrets(env)
   await checkApi(env)
   await checkDatabase(env, readPhone(process.argv.slice(2)))
   console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`)
   process.exitCode = failures === 0 ? 0 : 1
} else {
   process.exitCode = 1
}
