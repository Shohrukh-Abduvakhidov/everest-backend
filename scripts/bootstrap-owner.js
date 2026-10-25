import pool from '../src/configs/db.js';
import { accountAdminService } from '../src/services/account-admin-service.js';

const phoneIndex = process.argv.indexOf('--phone');
const phone = phoneIndex >= 0 ? process.argv[phoneIndex + 1] : undefined;

try {
  if (!phone) throw new Error('Usage: npm run bootstrap:owner -- --phone +992...');
  const result = await accountAdminService.bootstrapOwner(phone);
  console.log('Owner bootstrap completed', result);
} catch (error) {
  console.error('Owner bootstrap failed', { code: error.code || 'BOOTSTRAP_FAILED', message: error.message });
  process.exitCode = 1;
} finally {
  await pool.end();
}
