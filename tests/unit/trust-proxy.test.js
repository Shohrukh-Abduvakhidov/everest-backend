import assert from 'node:assert/strict'
import test from 'node:test'

import express from 'express'

import { parseTrustProxy } from '../../src/utils/trust-proxy.js'

test('TRUST_PROXY parses to false, a hop count or an address list', () => {
   assert.equal(parseTrustProxy(undefined), false)
   assert.equal(parseTrustProxy(''), false)
   assert.equal(parseTrustProxy('false'), false)
   assert.equal(parseTrustProxy('1'), 1)
   assert.equal(parseTrustProxy(' 2 '), 2)
   assert.deepEqual(parseTrustProxy('loopback, 172.16.0.0/12'), ['loopback', '172.16.0.0/12'])
   assert.deepEqual(parseTrustProxy('10.0.0.1,fd00::/8,uniquelocal'), ['10.0.0.1', 'fd00::/8', 'uniquelocal'])
})

test('TRUST_PROXY rejects values that are unsafe or malformed', () => {
   for (const raw of ['true', '0', '11', '-1', 'yes', 'loopback,', 'loopback,,10.0.0.0/8', '172.16.0.0/33',
      '300.1.1.1', '10.0.0.0/8/1', 'local host', '::1/129']) {
      assert.throws(() => parseTrustProxy(raw), /Invalid TRUST_PROXY value/, raw)
   }
})

async function ipFor(trustProxy, forwardedFor) {
   const app = express()
   app.set('trust proxy', parseTrustProxy(trustProxy))
   app.get('/', (req, res) => res.json({ ip: req.ip }))
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   try {
      const headers = forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers })
      return (await response.json()).ip
   } finally {
      await new Promise((resolve) => server.close(resolve))
   }
}

test('a trusted proxy socket exposes the forwarded client address', async () => {
   assert.equal(await ipFor('loopback', '203.0.113.7'), '203.0.113.7')
   assert.equal(await ipFor('1', '203.0.113.7'), '203.0.113.7')
})

test('an untrusted socket ignores X-Forwarded-For', async () => {
   assert.match(await ipFor(undefined, '203.0.113.7'), /127\.0\.0\.1$/)
   assert.match(await ipFor('10.0.0.0/8', '203.0.113.7'), /127\.0\.0\.1$/)
})

test('a spoofed left-hand X-Forwarded-For entry does not change the client address', async () => {
   assert.equal(await ipFor('loopback', '198.51.100.1, 203.0.113.7'), '203.0.113.7')
   assert.equal(await ipFor('loopback', '10.9.9.9, 203.0.113.7'), '203.0.113.7')
})
