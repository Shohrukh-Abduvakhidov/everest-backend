import { pathToFileURL } from 'node:url';

import app from './app.js';
import pool from './configs/db.js';
import env from './configs/env.js';
import * as healthService from './services/health-service.js';

async function start({ port = env.port, registerSignals = true } = {}) {
  await healthService.getReadiness();

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, () => resolve(listener));
    listener.once('error', reject);
  });
  console.log(`EVEREST API listening on port ${server.address().port}`);

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
