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

test('login rate limits behind a trusted proxy count the real client address', async () => {
   const config = {
      ...env,
      jwtAccessSecret: 'auth-protection-integration-secret-longer-than-32-characters',
      authPublicRateLimit: 1,
      authRateWindowSeconds: 60,
      authRateBlockSeconds: 60,
   }
   const client = new Client(env.database)
   await client.connect()
   await client.query("DELETE FROM auth_security_counters WHERE scope = 'login.ip'")
   const app = createApp({ authProtection: { config }, passwordAuth: { config }, trustProxy: ['loopback'] })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port

   try {
      const login = (forwardedFor) => fetch(`http://127.0.0.1:${port}/api/v1/auth/login/password`, {
         method: 'POST',
         headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
         body: JSON.stringify({}),
      })
      assert.notEqual((await login('203.0.113.10')).status, 429)
      // A different student behind the same proxy has an independent allowance.
      assert.notEqual((await login('203.0.113.11')).status, 429)
      // Forging a left-hand entry does not escape the limit of the real address.
      assert.equal((await login('198.51.100.99, 203.0.113.10')).status, 429)
      assert.equal((await login('203.0.113.11')).status, 429)
   } finally {
      await client.query("DELETE FROM auth_security_counters WHERE scope = 'login.ip'")
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
