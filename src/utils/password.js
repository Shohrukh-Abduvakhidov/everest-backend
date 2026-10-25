import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);
const algorithm = 'scrypt';
const cost = 16384;
const blockSize = 8;
const parallelization = 1;
const keyLength = 64;
const maxMemory = 32 * 1024 * 1024;

async function derive(password, salt) {
  return scrypt(password, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: maxMemory,
  });
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  return [algorithm, cost, blockSize, parallelization,
    salt.toString('base64url'), derived.toString('base64url')].join('$');
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== algorithm) return false;

  const [encodedCost, encodedBlockSize, encodedParallelization] = parts.slice(1, 4).map(Number);
  if (encodedCost !== cost || encodedBlockSize !== blockSize
      || encodedParallelization !== parallelization) return false;

  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length !== 16 || expected.length !== keyLength) return false;
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export { hashPassword, verifyPassword };
