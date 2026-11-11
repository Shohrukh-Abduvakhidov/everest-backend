import { pathToFileURL } from 'node:url';

import app from './app.js';
import pool from './configs/db.js';
import env from './configs/env.js';
import * as healthService from './services/health-service.js';

async function start({ port = env.port, registerSignals = true } = {}) {
  await healthService.getReadiness();
  if (env.nodeEnv === 'production' && env.trustProxy === false) {
    console.warn('TRUST_PROXY is not set: behind a reverse proxy every client shares the proxy IP for rate limits');
  }

  const server = await new Promise((resolve, reject) => {
    // Express 5 passes listen errors such as EADDRINUSE to this callback.
    const listener = app.listen(port, (error) => {
      if (error) reject(error);
      else resolve(listener);
    });
  });
  console.log(`EVEREST API listening on port ${server.address().port} (database ${env.database.database})`);

  let shutdownPromise;
  function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    console.log(`Received ${signal}; shutting down`);

    shutdownPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.closeAllConnections();
        reject(new Error('Graceful shutdown timed out'));
      }, env.shutdownTimeoutMs);
      timeout.unref();

      server.close(async (serverError) => {
        clearTimeout(timeout);
        try {
          await pool.end();
          if (serverError) reject(serverError);
          else resolve();
        } catch (poolError) {
          reject(poolError);
        }
      });
    });

    return shutdownPromise;
  }

  if (registerSignals) {
    process.once('SIGTERM', () => shutdown('SIGTERM').catch(handleShutdownError));
    process.once('SIGINT', () => shutdown('SIGINT').catch(handleShutdownError));
  }

  return { server, shutdown };
}

function handleShutdownError(error) {
  console.error('Graceful shutdown failed', { code: error.code, message: error.message });
  process.exitCode = 1;
}

const isDirectRun = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  start().catch(async (error) => {
    console.error('Server startup failed', { code: error.code, message: error.message });
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
}

export { start };
