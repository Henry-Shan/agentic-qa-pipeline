import { describe, expect, it } from 'vitest';
import { deriveArea } from '../src/envelope';
import { parsePrNumber, tailChars } from '../src/util';

describe('deriveArea', () => {
  it('uses the source_file directory', () => {
    expect(deriveArea({ source_file: 'components/inventory/ItemRow.tsx', route: '/x' })).toBe(
      'components/inventory',
    );
  });
  it('falls back to the first route segment when source_file is missing', () => {
    expect(deriveArea({ source_file: null, route: '/inventory/items' })).toBe('inventory');
  });
  it('falls back to the route for a root-level source file', () => {
    expect(deriveArea({ source_file: 'page.tsx', route: '/orders' })).toBe('orders');
  });
  it('defaults to general', () => {
    expect(deriveArea({ source_file: null, route: null })).toBe('general');
    expect(deriveArea({ source_file: '', route: '/' })).toBe('general');
  });
});

describe('parsePrNumber', () => {
  it('extracts the PR number from a GitHub URL', () => {
    expect(parsePrNumber('https://github.com/your-org/your-app/pull/9999')).toBe(9999);
  });
  it('returns null for non-PR urls', () => {
    expect(parsePrNumber('https://github.com/your-org/your-app')).toBeNull();
    expect(parsePrNumber(null)).toBeNull();
  });
});

describe('tailChars', () => {
  it('keeps short strings intact and trims long ones from the front', () => {
    expect(tailChars('abc', 5)).toBe('abc');
    expect(tailChars('abcdefgh', 3)).toBe('fgh');
  });
});
