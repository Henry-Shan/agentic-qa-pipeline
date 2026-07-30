// Pure secret-scrubbing helpers. No DOM access so they unit-test in isolation.

export const REDACTED = '[redacted]';

// eyJ… base64url runs — JWTs, Supabase keys. Segments after the header are optional
// so a bare header-only leak is still caught.
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{2,})*/g;

// `Bearer <blob>` / `Basic <blob>` credentials wherever they appear in text.
// Blob must be ≥16 chars so prose like "basic understanding" survives.
const SCHEME_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

// key=value / key: "value" pairs — query strings, JSON-ish blobs, cookie strings.
const KV_RE =
  /((?:authorization|set-cookie|cookie|api[-_]?key|[\w-]*token|secret|password)["']?\s*[:=]\s*["']?)([^&"'\s;]{4,})/gi;

const SENSITIVE_KEY_RE = /(authorization|cookie|api[-_]?key|token|secret|password)/i;

const MAX_DEPTH = 8;

export function scrubString(input: string): string {
  return input
    .replace(JWT_RE, REDACTED)
    .replace(SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KV_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);
}

/**
 * Deep-scrub any value: sensitive object keys are replaced wholesale, every
 * string is run through scrubString. Cycles and over-deep branches are dropped.
 */
export function scrubValue<T>(value: T): T {
  return walk(value, new WeakSet(), 0) as T;
}

function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value) || depth >= MAX_DEPTH) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : walk(v, seen, depth + 1);
  }
  return out;
}
