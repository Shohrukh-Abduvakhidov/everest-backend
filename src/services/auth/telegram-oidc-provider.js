import { createLocalJWKSet, jwtVerify } from 'jose';

import AppError from '../../utils/app-error.js';
import { safeHashEquals } from '../../utils/telegram-crypto.js';

const expectedIssuer = 'https://oauth.telegram.org';
const allowedAlgorithms = new Set(['RS256', 'ES256']);

class TelegramOidcProvider {
  constructor(config, fetchImplementation = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImplementation;
    this.metadata = null;
    this.jwks = null;
  }

  async discover() {
    if (this.metadata) return this.metadata;
    const response = await this.fetch(this.config.discoveryUrl, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new AppError(502, 'TELEGRAM_DISCOVERY_FAILED', 'Telegram authentication is unavailable');
    const metadata = await response.json();
    if (metadata.issuer !== expectedIssuer) {
      throw new AppError(502, 'TELEGRAM_DISCOVERY_INVALID', 'Telegram authentication is unavailable');
    }
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof metadata[key] !== 'string' || !metadata[key].startsWith('https://')) {
        throw new AppError(502, 'TELEGRAM_DISCOVERY_INVALID', 'Telegram authentication is unavailable');
      }
    }
    this.metadata = metadata;
    return metadata;
  }

  async buildAuthorizationUrl({ state, nonce, codeChallenge }) {
    const metadata = await this.discover();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'openid profile phone telegram:bot_access',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code, codeVerifier }) {
    const metadata = await this.discover();
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const response = await this.fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId,
        code_verifier: codeVerifier,
      }),
    });
    if (!response.ok) throw new AppError(401, 'TELEGRAM_CODE_EXCHANGE_FAILED', 'Telegram authorization failed');
    const tokenSet = await response.json();
    if (typeof tokenSet.id_token !== 'string') {
      throw new AppError(401, 'TELEGRAM_TOKEN_INVALID', 'Telegram authorization failed');
    }
    return tokenSet;
  }

  async validateIdToken(idToken, expectedNonceHash) {
    const metadata = await this.discover();
    if (!this.jwks) {
      const response = await this.fetch(metadata.jwks_uri, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new AppError(502, 'TELEGRAM_JWKS_FAILED', 'Telegram authentication is unavailable');
      this.jwks = createLocalJWKSet(await response.json());
    }
    const advertisedAlgorithms = Array.isArray(metadata.id_token_signing_alg_values_supported)
      ? metadata.id_token_signing_alg_values_supported.filter((value) => allowedAlgorithms.has(value))
      : ['RS256'];
    try {
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: expectedIssuer,
        audience: this.config.clientId,
        algorithms: advertisedAlgorithms,
        requiredClaims: ['sub', 'nonce', 'iat', 'exp'],
      });
      if (typeof payload.nonce !== 'string' || !safeHashEquals(payload.nonce, expectedNonceHash)) {
        throw new AppError(401, 'TELEGRAM_NONCE_INVALID', 'Telegram authorization failed');
      }
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new AppError(401, 'TELEGRAM_SUBJECT_INVALID', 'Telegram authorization failed');
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(401, 'TELEGRAM_ID_TOKEN_INVALID', 'Telegram authorization failed');
    }
  }
}

export { TelegramOidcProvider, expectedIssuer };
