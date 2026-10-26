import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'

const { Client } = pg

test('public authentication rate limits return a stable retry response', async () => {
   const config = {
      ...env,
      jwtAccessSecret: 'auth-protection-integration-secret-longer-than-32-characters',
      authPublicRateLimit: 1,
      authRateWindowSeconds: 60,
      authRateBlockSeconds: 60,
   }
   const client = new Client(env.database)
   await client.connect()
   await client.query("DELETE FROM auth_security_counters WHERE scope = 'register.ip'")
   const app = createApp({ authProtection: { config }, passwordAuth: { config } })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port

   try {
      const request = () => fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({}),
      })
      assert.equal((await request()).status, 400)
      const limited = await request()
      assert.equal(limited.status, 429)
      assert.equal((await limited.json()).error.code, 'AUTH_RATE_LIMITED')
      assert.ok(Number(limited.headers.get('retry-after')) >= 1)
   } finally {
      await client.query("DELETE FROM auth_security_counters WHERE scope = 'register.ip'")
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
