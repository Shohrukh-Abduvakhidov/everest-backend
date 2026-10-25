import { passwordRecoveryService } from '../services/password-recovery-service.js'

function createPasswordRecoveryController(service = passwordRecoveryService) {
  async function request(requestObject, response) {
    response.status(202).json({ data: await service.request(requestObject.body) })
  }

  async function verify(requestObject, response) {
    response.json({ data: await service.verify(requestObject.body) })
  }

  async function reset(requestObject, response) {
    response.json({ data: await service.reset(requestObject.body) })
  }

  return { request, reset, verify }
}

export { createPasswordRecoveryController }
