import assert from 'node:assert/strict';
import test from 'node:test';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { TelegramOidcProvider } from '../../src/services/auth/telegram-oidc-provider.js';
import { sha256Hex } from '../../src/utils/telegram-crypto.js';

const issuer = 'https://oauth.telegram.org';
const clientId = '123456789';
const nonce = 'verified-test-nonce';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const { privateKey: wrongPrivateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key';
jwk.use = 'sig';
jwk.alg = 'RS256';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/auth`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  id_token_signing_alg_values_supported: ['RS256'],
};

const fetchMock = async (url) => {
  if (url.endsWith('openid-configuration')) return response(metadata);
  if (url.endsWith('jwks.json')) return response({ keys: [jwk] });
  throw new Error(`Unexpected URL: ${url}`);
};

async function token(overrides = {}) {
  return new SignJWT({ nonce, id: 123456, ...overrides.payload })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer || issuer)
    .setAudience(overrides.audience || clientId)
    .setSubject('telegram-subject')
    .setIssuedAt()
    .setExpirationTime(overrides.expirationTime ?? '5m')
    .sign(overrides.signingKey || privateKey);
}

test('validates Telegram ID token signature, issuer, audience, expiry, nonce, and subject', async () => {
  const provider = new TelegramOidcProvider({
    discoveryUrl: `${issuer}/.well-known/openid-configuration`, clientId,
  }, fetchMock);
  const claims = await provider.validateIdToken(await token(), sha256Hex(nonce));
  assert.equal(claims.sub, 'telegram-subject');

  await assert.rejects(
    provider.validateIdToken(await token({ audience: 'wrong' }), sha256Hex(nonce)),
    (error) => error.code === 'TELEGRAM_ID_TOKEN_INVALID'
  );
  await assert.rejects(
    provider.validateIdToken(await token({ issuer: 'https://wrong.example' }), sha256Hex(nonce)),
    (error) => error.code === 'TELEGRAM_ID_TOKEN_INVALID'
  );
  await assert.rejects(
    provider.validateIdToken(await token({ expirationTime: 0 }), sha256Hex(nonce)),
    (error) => error.code === 'TELEGRAM_ID_TOKEN_INVALID'
  );
  await assert.rejects(
    provider.validateIdToken(await token({ signingKey: wrongPrivateKey }), sha256Hex(nonce)),
    (error) => error.code === 'TELEGRAM_ID_TOKEN_INVALID'
  );
  await assert.rejects(
    provider.validateIdToken(await token(), sha256Hex('wrong-nonce')),
    (error) => error.code === 'TELEGRAM_NONCE_INVALID'
  );
});
