const SENSITIVE_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._\-]+/gi,
  /(token[=:]\s*)[A-Za-z0-9._\-]+/gi,
  /(password[=:]\s*)\S+/gi,
]

export function redactText(value) {
  const text = String(value ?? '')
  return SENSITIVE_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, (_, prefix) => `${prefix}[REDACTED]`),
    text,
  )
}

export function sanitizeError(error) {
  const source = error instanceof Error ? error : new Error(String(error ?? 'unknown'))
  return {
    name: source.name,
    message: redactText(source.message),
    stack: source.stack ? redactText(source.stack.split('\n').slice(0, 3).join('\n')) : undefined,
  }
}
