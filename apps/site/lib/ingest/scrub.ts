// Server-side secret scrubbing for ingest payloads (second pass after the widget's own).
//
// The value-level regexes are duplicated from packages/widget/src/scrub.ts —
// keep them in sync BY HAND (no cross-workspace import from the widget).

const REDACTED = '[redacted]';

const SECRET_KEY_RE = /(authorization|set-cookie|cookie|apikey|api[-_]?key|token)/i;

// eyJ… base64url runs — JWTs, Supabase keys. Segments after the header are optional
// so a bare header-only leak is still caught.
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{2,})*/g;

// `Bearer <blob>` / `Basic <blob>` credentials wherever they appear in text.
// Blob must be ≥16 chars so prose like "basic understanding" survives.
const SCHEME_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

// key=value / key: "value" pairs — query strings, JSON-ish blobs, cookie strings.
// `[\w-]*token` also covers Supabase `sb-<ref>-auth-token=…` auth cookies.
const KV_RE =
  /((?:authorization|set-cookie|cookie|api[-_]?key|[\w-]*token|secret|password)["']?\s*[:=]\s*["']?)([^&"'\s;]{4,})/gi;

/** Redact secret-shaped substrings inside a string VALUE, wherever it sits in the payload. */
function scrubString(input: string): string {
  return input
    .replace(JWT_RE, REDACTED)
    .replace(SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KV_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : walk(val);
    }
    return out;
  }
  return value;
}

export function scrubSecrets<T>(value: T): T {
  return walk(value) as T;
}
