import * as healthRepository from '../repositories/health-repository.js';

async function getReadiness() {
  const databaseReady = await healthRepository.checkDatabase();
  return { status: databaseReady ? 'ready' : 'not_ready' };
}

export { getReadiness };
