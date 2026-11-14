/** Stable errors shared by the application and HTTP adapter. */
export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function ensure(condition, code, message, status = 400) {
  if (!condition) {
    throw new DomainError(code, message, status);
  }
}

export function text(value, label, maximum = 200) {
  ensure(typeof value === 'string', 'INVALID_INPUT', `${label}必须为文本`);
  const result = value.trim();
  ensure(
    result.length > 0 && result.length <= maximum,
    'INVALID_INPUT',
    `${label}长度应为 1～${maximum} 字`,
  );
  return result;
}

export function timestamp(value, label) {
  ensure(typeof value === 'string', 'INVALID_TIME', `${label}应为 ISO 时间`);
  const result = Date.parse(value);
  ensure(Number.isFinite(result), 'INVALID_TIME', `${label}不是有效时间`);
  return result;
}

export function integer(value, label, minimum = 1, maximum = 1000000) {
  ensure(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    'INVALID_NUMBER',
    `${label}应为 ${minimum}～${maximum} 的整数`,
  );
  return value;
}
