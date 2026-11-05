import { start } from '../src/server.js';

let stopServer;

try {
  const { server, shutdown } = await start({ port: 0, registerSignals: false });
  stopServer = shutdown;
  const port = server.address().port;
  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const readinessResponse = await fetch(`http://127.0.0.1:${port}/api/v1/ready`);
  const health = await healthResponse.json();
  const readiness = await readinessResponse.json();

  if (healthResponse.status !== 200 || health.data?.status !== 'ok') {
    throw new Error('Health response was unexpected');
  }
  if (readinessResponse.status !== 200 || readiness.data?.status !== 'ready') {
    throw new Error('Readiness response was unexpected');
  }

  const busyPortError = await start({ port, registerSignals: false }).then(
    () => null,
    (error) => error,
  );
  if (busyPortError?.code !== 'EADDRINUSE') {
    throw new Error('A busy port must reject startup with EADDRINUSE');
  }

  await shutdown('INTEGRATION_TEST');
  stopServer = undefined;
  console.log(JSON.stringify({ health, readiness, gracefulShutdown: true }, null, 2));
} catch (error) {
  console.error('Server integration test failed', { code: error.code, message: error.message });
  process.exitCode = 1;
  await stopServer?.('INTEGRATION_TEST_FAILURE').catch(() => {});
}
