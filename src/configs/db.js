import pg from 'pg';

import env from './env.js';

const { Pool } = pg;

const pool = new Pool({
  ...env.database,
  max: env.dbPoolMax,
  connectionTimeoutMillis: env.dbConnectionTimeoutMs,
  idleTimeoutMillis: env.dbIdleTimeoutMs,
});

pool.on('error', (error) => {
  console.error('Unexpected idle database connection error', { code: error.code });
});

export default pool;
