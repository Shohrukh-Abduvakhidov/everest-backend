import assert from 'node:assert/strict'
import test from 'node:test'

import {
   authorizePermissionService,
   normalizePermissionCode,
} from '../../src/services/authorization-service.js'

test('authorizes a canonical action permission for a canonical BIGINT user', async () => {
   const calls = []

   await authorizePermissionService(
      '9223372036854775807',
      'accounts.approve',
      {},
      {
         repository: {
            hasPermission: async (...args) => {
               calls.push(args)
               return true
            },
         },
      },
   )

   assert.deepEqual(calls, [['9223372036854775807', 'accounts.approve']])
})

test('denies missing permissions with a stable default error', async () => {
   await assert.rejects(
      authorizePermissionService(
         '1',
         'accounts.block',
         {},
         { repository: { hasPermission: async () => false } },
      ),
      (error) => error.status === 403 && error.code === 'ACTION_FORBIDDEN',
   )
})

test('supports a route-specific stable denial and rejects invalid permission codes', async () => {
   await assert.rejects(
      authorizePermissionService(
         '1',
         'accounts.reject',
         { errorCode: 'ADMIN_ROLE_REQUIRED', message: 'Administrator role is required' },
         { repository: { hasPermission: async () => false } },
      ),
      (error) => error.code === 'ADMIN_ROLE_REQUIRED'
         && error.message === 'Administrator role is required',
   )

   for (const value of ['', 'accounts', 'Accounts.read', 'accounts.read;drop', null]) {
      assert.throws(() => normalizePermissionCode(value), TypeError)
   }
})
