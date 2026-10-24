import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

function randomBase64Url(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

function sha256Buffer(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function sha256Hex(value) {
  return sha256Buffer(value).toString('hex');
}

function createPkcePair() {
  const verifier = randomBase64Url(48);
  const challenge = sha256Buffer(verifier).toString('base64url');
  return { verifier, challenge };
}

function deriveEncryptionKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('Telegram client secret is too short for state encryption');
  }
  return createHash('sha256').update(`everest:telegram-oidc-state:${secret}`, 'utf8').digest();
}

function encryptStateSecret(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptStateSecret(value, secret) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted OIDC state');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function safeHashEquals(value, expectedHash) {
  const actual = sha256Buffer(value);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export {
  createPkcePair,
  decryptStateSecret,
  encryptStateSecret,
  randomBase64Url,
  safeHashEquals,
  sha256Hex,
};
