import {
  MAX_QUANTITY,
  normalizeAddress,
  normalizeName,
  normalizeQuantity,
  PRODUCT_MAX_QUANTITY,
  ValidationError,
  validateCategoryInput,
  validateId,
  validateItemInput,
  validateLocationInput,
} from '../src/inventory/validation';

describe('inventory domain validation (M1, no persistence)', () => {
  test('names are trimmed and must be nonblank', () => {
    expect(normalizeName('  Rice  ')).toBe('Rice');
    expect(() => normalizeName('')).toThrow(ValidationError);
    expect(() => normalizeName('   ')).toThrow(ValidationError);
    expect(() => normalizeName(null)).toThrow(ValidationError);
    expect(() => normalizeName(42)).toThrow(ValidationError);
  });

  test('names keep their original text: no case, accent, or length changes', () => {
    // The adopted 120/80 product caps apply through the entity validators
    // (validateItemInput/validateLocationInput/validateCategoryInput);
    // the unbounded normalizeName default still performs no transformation.
    const longName = 'a'.repeat(500);
    expect(normalizeName(longName)).toBe(longName);
    expect(normalizeName('café')).toBe('café');
    expect(normalizeName('CAFÉ')).toBe('CAFÉ');
  });

  test('optional address normalizes every blank form consistently to null', () => {
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress('   ')).toBeNull();
    expect(normalizeAddress('  Casa  ')).toBe('Casa');
    expect(() => normalizeAddress(42)).toThrow(ValidationError);
  });

  test('quantity zero is valid and means exhausted', () => {
    expect(normalizeQuantity(0)).toBe(0);
  });

  test('invalid quantities are rejected with a typed error', () => {
    expect(() => normalizeQuantity(-1)).toThrow(ValidationError);
    expect(() => normalizeQuantity(1.5)).toThrow(ValidationError);
    expect(() => normalizeQuantity(Number.NaN)).toThrow(ValidationError);
    expect(() => normalizeQuantity(Number.POSITIVE_INFINITY)).toThrow(
      ValidationError,
    );
    expect(() => normalizeQuantity('2')).toThrow(ValidationError);
    expect(() => normalizeQuantity(null)).toThrow(ValidationError);
    expect(() => normalizeQuantity(undefined)).toThrow(ValidationError);
  });

  test('quantity honors the technical guard plus the adopted product bound', () => {
    // Split (S10): MAX_QUANTITY stays the technical safe-integer guard
    // mirrored by the v2 SQL CHECK; the 999999 product bound is enforced
    // in this domain layer, which is the only writer.
    expect(MAX_QUANTITY).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => normalizeQuantity(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      ValidationError,
    );
    try {
      normalizeQuantity(Number.MAX_SAFE_INTEGER);
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('out-of-range');
    }
    expect(normalizeQuantity(PRODUCT_MAX_QUANTITY)).toBe(999999);
    expect(() => normalizeQuantity(1000000)).toThrow(ValidationError);
  });

  test('ids must be positive safe integers (valid referential values)', () => {
    expect(validateId(1, 'locationId')).toBe(1);
    expect(() => validateId(0, 'locationId')).toThrow(ValidationError);
    expect(() => validateId(-1, 'locationId')).toThrow(ValidationError);
    expect(() => validateId(1.5, 'locationId')).toThrow(ValidationError);
    expect(() => validateId('1', 'locationId')).toThrow(ValidationError);
    expect(() => validateId(null, 'locationId')).toThrow(ValidationError);
  });

  test('location input requires a name and normalizes the address', () => {
    expect(validateLocationInput({ name: ' Casa ' })).toEqual({
      name: 'Casa',
      address: null,
    });
    expect(
      validateLocationInput({ name: 'Bodega', address: ' Calle 1 ' }),
    ).toEqual({ name: 'Bodega', address: 'Calle 1' });
    expect(() => validateLocationInput({ name: '  ' })).toThrow(
      ValidationError,
    );
    // Duplicate names are not rejected: uniqueness is proposed, not approved.
    expect(validateLocationInput({ name: 'Casa' })).toEqual({
      name: 'Casa',
      address: null,
    });
  });

  test('category input requires a nonblank name', () => {
    expect(validateCategoryInput({ name: ' Grains ' })).toEqual({
      name: 'Grains',
    });
    expect(() => validateCategoryInput({ name: '' })).toThrow(ValidationError);
  });

  test('item input requires a valid location reference (missing or null rejected)', () => {
    const valid = validateItemInput({
      name: 'Rice',
      quantity: 2,
      locationId: 1,
    });
    expect(valid).toEqual({
      name: 'Rice',
      quantity: 2,
      locationId: 1,
      categoryIds: [],
    });
    expect(() =>
      validateItemInput({ name: 'Rice', quantity: 1, locationId: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({
        name: 'Rice',
        quantity: 1,
        locationId: null as unknown as number,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({
        name: 'Rice',
        quantity: 1,
      } as unknown as { name: string; quantity: number; locationId: number }),
    ).toThrow(ValidationError);
  });

  test('item input accepts zero or many categories but rejects duplicates', () => {
    expect(
      validateItemInput({
        name: 'Rice',
        quantity: 0,
        locationId: 1,
        categoryIds: [2, 3],
      }),
    ).toEqual({
      name: 'Rice',
      quantity: 0,
      locationId: 1,
      categoryIds: [2, 3],
    });
    expect(() =>
      validateItemInput({
        name: 'Rice',
        quantity: 1,
        locationId: 1,
        categoryIds: [2, 2],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({
        name: 'Rice',
        quantity: 1,
        locationId: 1,
        categoryIds: [0],
      }),
    ).toThrow(ValidationError);
  });

  test('item input rejects blank names and invalid quantities', () => {
    expect(() =>
      validateItemInput({ name: '  ', quantity: 1, locationId: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({ name: 'Rice', quantity: -1, locationId: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({ name: 'Rice', quantity: 0.5, locationId: 1 }),
    ).toThrow(ValidationError);
  });

  test('S10 RED: item name over 120 after trim is rejected; exactly 120 accepted', () => {
    const max = 'a'.repeat(120);
    expect(
      validateItemInput({ name: max, quantity: 1, locationId: 1 }).name,
    ).toBe(max);
    expect(() =>
      validateItemInput({ name: 'a'.repeat(121), quantity: 1, locationId: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateItemInput({
        name: `  ${'a'.repeat(121)}  `,
        quantity: 1,
        locationId: 1,
      }),
    ).toThrow(ValidationError);
  });

  test('S10 RED: quantity 999999 accepted and 1000000 rejected; zero stays valid', () => {
    expect(normalizeQuantity(0)).toBe(0);
    expect(normalizeQuantity(999999)).toBe(999999);
    expect(() => normalizeQuantity(1000000)).toThrow(ValidationError);
    expect(
      validateItemInput({ name: 'Rice', quantity: 999999, locationId: 1 })
        .quantity,
    ).toBe(999999);
    expect(() =>
      validateItemInput({ name: 'Rice', quantity: 1000000, locationId: 1 }),
    ).toThrow(ValidationError);
  });

  test('S10 RED: location name over 80 after trim is rejected; 80 accepted', () => {
    const max = 'b'.repeat(80);
    expect(validateLocationInput({ name: max })).toEqual({
      name: max,
      address: null,
    });
    expect(() => validateLocationInput({ name: 'b'.repeat(81) })).toThrow(
      ValidationError,
    );
  });

  test('S10 RED: category name over 80 after trim is rejected; 80 accepted', () => {
    const max = 'c'.repeat(80);
    expect(validateCategoryInput({ name: max })).toEqual({ name: max });
    expect(() => validateCategoryInput({ name: 'c'.repeat(81) })).toThrow(
      ValidationError,
    );
  });

  test('S10 RED: out-of-range errors carry field and code', () => {
    try {
      validateItemInput({ name: 'a'.repeat(121), quantity: 1, locationId: 1 });
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('name');
      expect((error as ValidationError).code).not.toBe('blank');
    }
    try {
      normalizeQuantity(1000000);
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('quantity');
      expect((error as ValidationError).code).not.toBe('invalid');
    }
  });

  test('validation errors carry field and code for translated UI copy', () => {
    try {
      validateItemInput({ name: '  ', quantity: 1, locationId: 1 });
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('name');
      expect(typeof (error as ValidationError).code).toBe('string');
    }
  });
});
