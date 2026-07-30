import { describe, expect, it } from 'vitest';
import { REDACTED, scrubString, scrubValue } from '../src/scrub';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('scrubString', () => {
  it('redacts JWT-shaped strings', () => {
    const out = scrubString(`sent ${JWT} ok`);
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/^sent .* ok$/);
  });

  it('redacts a bare eyJ header without dot segments', () => {
    expect(scrubString('key=eyJhbGciOiJIUzI1NiIsInR5cCJ9')).not.toContain('eyJhbGci');
  });

  it('leaves short eyJ prefixes alone', () => {
    expect(scrubString('eyJab is fine')).toBe('eyJab is fine');
  });

  it('redacts Bearer credentials', () => {
    const out = scrubString('Authorization: Bearer abc.DEF-123456_zzz.qqq');
    expect(out).not.toContain('abc.DEF-123456_zzz.qqq');
    expect(out).toContain(REDACTED);
  });

  it('does not maul prose containing the word basic', () => {
    expect(scrubString('a basic understanding')).toBe('a basic understanding');
  });

  it('redacts token-shaped query-string values, keeping other params', () => {
    const out = scrubString('https://x.com/a?token=SECRET123&page=2');
    expect(out).not.toContain('SECRET123');
    expect(out).toContain('page=2');
    expect(out).toContain(`token=${REDACTED}`);
  });

  it('redacts access_token / refresh_token style keys', () => {
    const out = scrubString('/cb?access_token=aaaa1111&refresh_token=bbbb2222&state=keepme');
    expect(out).not.toContain('aaaa1111');
    expect(out).not.toContain('bbbb2222');
    expect(out).toContain('state=keepme');
  });

  it('redacts apikey variants', () => {
    const out = scrubString('api_key=abcd1234 apiKey: zzzz9999 x-api-key=qqqq8888');
    expect(out).not.toContain('abcd1234');
    expect(out).not.toContain('zzzz9999');
    expect(out).not.toContain('qqqq8888');
  });

  it('redacts passwords and secrets', () => {
    const out = scrubString('password=hunter42&secret=deadbeef');
    expect(out).not.toContain('hunter42');
    expect(out).not.toContain('deadbeef');
  });

  it('redacts cookie values but keeps trailing non-sensitive parts', () => {
    const out = scrubString('cookie: session=abc123def; theme=dark');
    expect(out).not.toContain('abc123def');
    expect(out).toContain('theme=dark');
  });

  it('redacts JSON-ish quoted pairs', () => {
    const out = scrubString('{"authorization": "Bearer abcdefgh12345678", "ok": true}');
    expect(out).not.toContain('abcdefgh12345678');
    expect(out).toContain('"ok": true');
  });

  it('leaves non-sensitive strings byte-identical', () => {
    const input = 'https://x.com/api/items?page=2&sort=asc token count: 4';
    expect(scrubString(input)).toBe(input);
  });
});

describe('scrubValue', () => {
  it('redacts sensitive keys wholesale in nested objects and arrays', () => {
    const out = scrubValue({
      authorization: 'Bearer zz',
      nested: { cookie: 'a=b', ok: 'fine' },
      arr: [{ token: 'abcd' }, 'plain'],
      count: 3,
    });
    expect(out.authorization).toBe(REDACTED);
    expect(out.nested.cookie).toBe(REDACTED);
    expect(out.nested.ok).toBe('fine');
    expect(out.arr[0]).toEqual({ token: REDACTED });
    expect(out.arr[1]).toBe('plain');
    expect(out.count).toBe(3);
  });

  it('scrubs JWT strings under non-sensitive keys', () => {
    const out = scrubValue({ note: `saw ${JWT}` });
    expect(out.note).not.toContain('eyJhbGci');
  });

  it('passes primitives through untouched', () => {
    expect(scrubValue(42)).toBe(42);
    expect(scrubValue(null)).toBeNull();
    expect(scrubValue(true)).toBe(true);
    expect(scrubValue(undefined)).toBeUndefined();
  });

  it('survives cyclic objects', () => {
    interface Cyclic {
      name: string;
      self?: Cyclic;
    }
    const obj: Cyclic = { name: 'loop' };
    obj.self = obj;
    const out = scrubValue(obj);
    expect(out.name).toBe('loop');
    expect(out.self).toBeUndefined();
  });

  it('drops branches deeper than the depth cap instead of recursing forever', () => {
    type Deep = { child?: Deep; label: string };
    const root: Deep = { label: 'level0' };
    let node = root;
    for (let i = 1; i < 12; i++) {
      const next: Deep = { label: `level${i}` };
      node.child = next;
      node = next;
    }
    const out = scrubValue(root);
    expect(out.label).toBe('level0');
    let probe: Deep | undefined = out;
    let depth = 0;
    while (probe) {
      depth += 1;
      probe = probe.child;
    }
    expect(depth).toBeLessThan(12);
  });
});
