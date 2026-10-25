const maxBigintId = 9223372036854775807n;

function normalizeInternalId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError('Invalid internal identifier');
  }
  if (BigInt(value) > maxBigintId) {
    throw new TypeError('Invalid internal identifier');
  }
  return value;
}

export { normalizeInternalId };
