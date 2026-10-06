import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en, es } from './resources';

export type SupportedLanguage = 'en' | 'es';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['en', 'es'];
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/** Normalize a BCP-47 tag (or nullish input) to a supported language. */
export function resolveLanguage(
  tag: string | null | undefined,
): SupportedLanguage {
  const normalized = (tag ?? '').trim().toLowerCase();
  if (
    normalized === 'es' ||
    normalized.startsWith('es-') ||
    normalized.startsWith('es_')
  ) {
    return 'es';
  }
  return DEFAULT_LANGUAGE;
}

/** Read the device locale via `expo-localization`, falling back to English. */
export function detectDeviceLanguage(): SupportedLanguage {
  try {
    const locales = getLocales();
    return resolveLanguage(locales?.[0]?.languageTag);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: detectDeviceLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
});

export default i18n;
