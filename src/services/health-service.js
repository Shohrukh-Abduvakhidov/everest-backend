import * as healthRepository from '../repositories/health-repository.js'

async function getReadinessService() {
   const databaseReady = await healthRepository.checkDatabase()
   return { status: databaseReady ? 'ready' : 'not_ready' }
}

const getReadiness = getReadinessService

export { getReadiness, getReadinessService }
