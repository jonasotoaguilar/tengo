/** English (default) and Spanish translation resources.
 *
 * `es` is typed as `typeof en` so a missing or extra key is a compile-time
 * error: the two languages can never drift apart silently.
 */
export const en = {
  appName: 'Tengo',
  readinessTitle: 'Tengo is ready',
  readinessSubtitle: 'Local-first household inventory foundation',
  statusInitializing: 'Setting up your local database…',
  statusReady: 'Local database is ready',
  statusError: 'Local database could not start',
  dbStateLabel: 'Database',
  languageLabel: 'Language',
};

export const es: typeof en = {
  appName: 'Tengo',
  readinessTitle: 'Tengo está listo',
  readinessSubtitle: 'Base local de inventario del hogar',
  statusInitializing: 'Preparando tu base de datos local…',
  statusReady: 'La base de datos local está lista',
  statusError: 'No se pudo iniciar la base de datos local',
  dbStateLabel: 'Base de datos',
  languageLabel: 'Idioma',
};
