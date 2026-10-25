import { accountAdminService } from '../services/account-admin-service.js';

function createAdminMiddleware(service = accountAdminService) {
  return async function adminMiddleware(request, _response, next) {
    try {
      await service.authorizeAdministrator(request.auth.userId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

const adminMiddleware = createAdminMiddleware();

export { adminMiddleware, createAdminMiddleware };
