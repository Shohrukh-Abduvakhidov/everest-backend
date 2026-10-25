import { accountAdminService } from '../services/account-admin-service.js';

function createAccountAdminController(service = accountAdminService) {
  const transition = (action) => async (request, response) => {
    response.json({ data: await service[action](request.auth.userId, request.params.userId) });
  };
  async function listPending(request, response) {
    response.json({ data: await service.listPending(request.query) });
  }
  return {
    approve: transition('approve'), block: transition('block'), listPending,
    reject: transition('reject'), unblock: transition('unblock'),
  };
}

export { createAccountAdminController };
