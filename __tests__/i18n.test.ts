import i18n, { detectDeviceLanguage, resolveLanguage } from '../src/i18n';
import { en } from '../src/i18n/resources';

describe('resolveLanguage', () => {
  test('maps Spanish tags to es', () => {
    expect(resolveLanguage('es')).toBe('es');
    expect(resolveLanguage('es-ES')).toBe('es');
    expect(resolveLanguage('es-MX')).toBe('es');
    expect(resolveLanguage('ES')).toBe('es');
  });

  test('maps English tags to en', () => {
    expect(resolveLanguage('en')).toBe('en');
    expect(resolveLanguage('en-US')).toBe('en');
  });

  test('falls back to en for unsupported, empty, or missing tags', () => {
    expect(resolveLanguage('fr')).toBe('en');
    expect(resolveLanguage('')).toBe('en');
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveLanguage(undefined)).toBe('en');
  });
});

describe('detectDeviceLanguage', () => {
  test('uses the mocked device locale (en-US -> en)', () => {
    expect(detectDeviceLanguage()).toBe('en');
  });
});

describe('translation resources', () => {
  test('every English key has a non-empty Spanish counterpart', () => {
    const es = (i18n.getResourceBundle('es', 'translation') ?? {}) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(en)) {
      expect(typeof es[key]).toBe('string');
      expect((es[key] as string).length).toBeGreaterThan(0);
    }
  });

  test('translates the readiness title to Spanish and back', async () => {
    await i18n.changeLanguage('es');
    expect(i18n.t('readinessTitle')).toBe('Tengo está listo');
    await i18n.changeLanguage('en');
    expect(i18n.t('readinessTitle')).toBe('Tengo is ready');
  });
});
