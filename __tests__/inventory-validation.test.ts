import {
  MAX_QUANTITY,
  normalizeAddress,
  normalizeName,
  normalizeQuantity,
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
    // 120/80-style product caps and accent folding are proposed, not
    // approved, so validation must not apply them.
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

  test('quantity honors the technical safe-integer bound, not a product cap', () => {
    expect(MAX_QUANTITY).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeQuantity(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => normalizeQuantity(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      ValidationError,
    );
    // A 999999-style product cap is not approved: values above it validate.
    expect(normalizeQuantity(1000000)).toBe(1000000);
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
