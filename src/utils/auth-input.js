import AppError from './app-error.js';

const e164Pattern = /^\+[1-9][0-9]{7,14}$/;

function validationError(field, message) {
  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }]);
}

function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 64
      || !/^\+[0-9()\s-]+$/.test(value.trim())) {
    throw validationError('phone', 'Phone must be a valid E.164 number');
  }
  const normalized = `+${value.trim().slice(1).replace(/[()\s-]/g, '')}`;
  if (!e164Pattern.test(normalized)) {
    throw validationError('phone', 'Phone must be a valid E.164 number');
  }
  return normalized;
}

function validatePassword(value) {
  if (typeof value !== 'string') {
    throw validationError('password', 'Password must be a string');
  }
  const length = [...value].length;
  if (length < 12 || length > 128 || !/\p{L}/u.test(value) || !/\p{N}/u.test(value)) {
    throw validationError(
      'password',
      'Password must be 12 to 128 characters and contain a letter and a number'
    );
  }
  return value;
}

function validateName(value, field) {
  if (typeof value !== 'string') {
    throw validationError(field, `${field === 'firstName' ? 'First' : 'Last'} name is required`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 100) {
    throw validationError(field, `${field === 'firstName' ? 'First' : 'Last'} name must be 1 to 100 characters`);
  }
  return normalized;
}

function validateBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed');
  }
  const unexpected = Object.keys(body).find((key) => !allowedFields.includes(key));
  if (unexpected) throw validationError(unexpected, 'Field is not allowed');
}

export { normalizePhone, validateBody, validateName, validatePassword };
