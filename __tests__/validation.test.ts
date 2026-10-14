/**
 * U2 domain validation: reminder threshold, barcode identity, expiry date.
 *
 * New rules (all optional at the type level; absent/blank means unset):
 * - `lowStockThreshold`: null/undefined when absent; otherwise a safe
 *   integer inside the S10 product bound (0-999999, reusing the quantity
 *   constants). Fractions, negatives, and over-bound values reject.
 * - `barcode`: null/undefined/blank when absent; otherwise a plausible
 *   code shape — 4-64 chars of letters, numbers, `.`, `-`, `_`, starting
 *   and ending with a letter or number (trimmed).
 * - `expiresOn`: null/undefined/blank when absent; otherwise an ISO
 *   calendar date (YYYY-MM-DD, real month/day, leap years honored).
 *
 * New user-facing strings need both en and es: the message assertions
 * below pin the field/code contract the localized copy keys off, and the
 * i18n resources carry the matching bilingual keys.
 */
import {
  normalizeBarcode,
  normalizeExpiresOn,
  normalizeLowStockThreshold,
  normalizeName,
  normalizeQuantity,
  PRODUCT_MAX_QUANTITY,
  ValidationError,
  validateItemInput,
  validateStockInput,
} from '../src/inventory/validation';

describe('low-stock threshold (U2)', () => {
  test('absent threshold normalizes to null (no reminder)', () => {
    expect(normalizeLowStockThreshold(undefined)).toBeNull();
    expect(normalizeLowStockThreshold(null)).toBeNull();
  });

  test('threshold honors the S10 product bound: 0 and 999999 pass', () => {
    expect(normalizeLowStockThreshold(0)).toBe(0);
    expect(normalizeLowStockThreshold(5)).toBe(5);
    expect(normalizeLowStockThreshold(PRODUCT_MAX_QUANTITY)).toBe(999999);
  });

  test('threshold rejects fractions, negatives, non-numbers, and over-bound values', () => {
    for (const bad of [-1, 1.5, Number.NaN, '5', 1000000]) {
      expect(() => normalizeLowStockThreshold(bad as never)).toThrow(
        ValidationError,
      );
    }
    expect(() =>
      normalizeLowStockThreshold(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow(ValidationError);
  });

  test('threshold errors carry field and code for translated UI copy', () => {
    try {
      normalizeLowStockThreshold(-1);
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('lowStockThreshold');
      expect((error as ValidationError).code).toBe('invalid');
    }
    try {
      normalizeLowStockThreshold(1000000);
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('lowStockThreshold');
      expect((error as ValidationError).code).toBe('out-of-range');
    }
  });
});

describe('barcode identity (U2)', () => {
  test('absent or blank barcode normalizes to null (no identity)', () => {
    expect(normalizeBarcode(undefined)).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
    expect(normalizeBarcode('')).toBeNull();
    expect(normalizeBarcode('   ')).toBeNull();
  });

  test('barcode trims and keeps verbatim text', () => {
    expect(normalizeBarcode('  12345678  ')).toBe('12345678');
    expect(normalizeBarcode('AbC-12_34.56')).toBe('AbC-12_34.56');
  });

  test('barcode accepts plausible code shapes between 4 and 64 chars', () => {
    expect(normalizeBarcode('1234')).toBe('1234');
    expect(normalizeBarcode('a'.repeat(64))).toBe('a'.repeat(64));
    expect(normalizeBarcode('EAN-5901234123457')).toBe('EAN-5901234123457');
  });

  test('barcode rejects too-short, too-long, and misshapen codes', () => {
    for (const bad of [
      'abc',
      'a',
      'a'.repeat(65),
      'ab cd',
      'abc/def',
      '-abc1',
      'abc1-',
      '.abc1',
      'abc1_',
      'café-1234',
    ]) {
      expect(() => normalizeBarcode(bad)).toThrow(ValidationError);
    }
    expect(() => normalizeBarcode(1234 as never)).toThrow(ValidationError);
  });

  test('barcode errors carry field and code for translated UI copy', () => {
    try {
      normalizeBarcode('ab');
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('barcode');
      expect((error as ValidationError).code).toBe('invalid');
    }
  });
});

describe('stock expiry date (U2)', () => {
  test('absent or blank expiry normalizes to null (no expiry)', () => {
    expect(normalizeExpiresOn(undefined)).toBeNull();
    expect(normalizeExpiresOn(null)).toBeNull();
    expect(normalizeExpiresOn('')).toBeNull();
    expect(normalizeExpiresOn('   ')).toBeNull();
  });

  test('expiry accepts ISO dates and trims surrounding whitespace', () => {
    expect(normalizeExpiresOn('2027-03-15')).toBe('2027-03-15');
    expect(normalizeExpiresOn('  2027-03-15  ')).toBe('2027-03-15');
    // Leap years honored: 2024-02-29 is real, 2023-02-29 is not.
    expect(normalizeExpiresOn('2024-02-29')).toBe('2024-02-29');
  });

  test('expiry rejects non-ISO shapes and impossible calendar dates', () => {
    for (const bad of [
      'not-a-date',
      '15-03-2027',
      '2027/03/15',
      '2027-3-5',
      '20270315',
      '2027-13-01',
      '2027-00-10',
      '2027-02-30',
      '2023-02-29',
      '2027-04-31',
    ]) {
      expect(() => normalizeExpiresOn(bad)).toThrow(ValidationError);
    }
    expect(() => normalizeExpiresOn(20270315 as never)).toThrow(
      ValidationError,
    );
  });

  test('expiry errors carry field and code for translated UI copy', () => {
    try {
      normalizeExpiresOn('tomorrow');
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('expiresOn');
      expect((error as ValidationError).code).toBe('invalid');
    }
  });
});

describe('item and stock inputs carry the U2 fields', () => {
  test('item input accepts threshold and barcode, stock rows accept expiry', () => {
    expect(
      validateItemInput({
        name: 'Rice',
        lowStockThreshold: 3,
        barcode: '  12345678  ',
        stock: [{ locationId: 1, quantity: 2, expiresOn: '2027-03-15' }],
      }),
    ).toEqual({
      name: 'Rice',
      lowStockThreshold: 3,
      barcode: '12345678',
      stock: [{ locationId: 1, quantity: 2, expiresOn: '2027-03-15' }],
      categoryIds: [],
    });
  });

  test('absent U2 fields normalize to null (existing callers unchanged)', () => {
    expect(validateItemInput({ name: 'Rice', stock: [] })).toEqual({
      name: 'Rice',
      lowStockThreshold: null,
      barcode: null,
      stock: [],
      categoryIds: [],
    });
    expect(validateStockInput({ locationId: 1, quantity: 2 })).toEqual({
      locationId: 1,
      quantity: 2,
      expiresOn: null,
    });
  });

  test('invalid U2 fields reject with typed errors before any write', () => {
    expect(() =>
      validateItemInput({
        name: 'Rice',
        stock: [],
        lowStockThreshold: -1,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({ name: 'Rice', stock: [], barcode: 'ab' }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({
        name: 'Rice',
        stock: [{ locationId: 1, quantity: 1, expiresOn: 'soon' }],
      }),
    ).toThrow(ValidationError);
  });
});

describe('U2 PRESERVE: existing validation still holds', () => {
  test('quantity bounds, name rules, zero-drop, and duplicate rejection are untouched', () => {
    // S10 quantity contract the threshold reuses.
    expect(normalizeQuantity(0)).toBe(0);
    expect(normalizeQuantity(999999)).toBe(999999);
    expect(() => normalizeQuantity(1000000)).toThrow(ValidationError);
    // Name contract.
    expect(normalizeName('  Rice  ')).toBe('Rice');
    expect(() => normalizeName('   ')).toThrow(ValidationError);
    // Zero rows still drop; duplicates still reject.
    expect(
      validateItemInput({
        name: 'Rice',
        stock: [{ locationId: 1, quantity: 0 }],
      }).stock,
    ).toEqual([]);
    expect(() =>
      validateItemInput({
        name: 'Rice',
        stock: [
          { locationId: 1, quantity: 1 },
          { locationId: 1, quantity: 2 },
        ],
      }),
    ).toThrow(ValidationError);
  });
});
