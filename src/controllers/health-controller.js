import * as healthService from '../services/health-service.js';

function getLiveness(_request, response) {
  response.json({ data: { status: 'ok' } });
}

async function getReadiness(_request, response) {
  const readiness = await healthService.getReadiness();
  response.json({ data: readiness });
}

export { getLiveness, getReadiness };
