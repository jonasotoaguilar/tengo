# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

One product that adapts its design language per OS: Material Design 3
conventions on Android, Human Interface Guidelines conventions on iOS,
built from a single Expo React Native codebase.

## Users

A single household keeping track of what it owns and where it is. The
primary user is a household member (not a team, not a business) doing
a concrete lookup or update: "do we have it, how much, and where is
it?" Typical situations are the kitchen, pantry, closet, garage, or
storage room. No roles, no sharing, no multi-user coordination: one
device, one on-device database.

## Product Purpose

Tengo is a local-first household inventory organized by location. It
exists so a household can record items with a name, quantity, and
location (plus an optional category), then later find, update, or
remove them without depending on a network, account, or server.

Success for the approved MVP means the user can create, edit, delete,
and search items entirely on-device, in English or Spanish. Search by
name is the approved baseline; matching by location or category is
proposed and undecided (see open decision 3).

## Positioning

The meaningfully different mechanism is deliberate smallness: one
household, one on-device SQLite database, no backend, no accounts, no
sync by design. The app itself sends data nowhere. That is not a
guarantee about OS-level backup or other device behavior outside the
app, which is unknown and must not be promised.

## Operating Context

- The app runs natively on Android and iOS via Expo React Native.
- The database is on-device SQLite (`expo-sqlite`, database
  `tengo.db`), opened and migrated at launch. See `src/db/index.ts`
  and `src/db/migrations.ts`.
- The device locale selects English or Spanish at launch via
  `expo-localization`; `es` is type-locked to `en` so keys cannot
  drift. See `src/i18n/index.ts` and `src/i18n/resources.ts`.
- Today the only implemented screen is the readiness screen in `App.tsx`
  (translated title, subtitle, DB bootstrap state). Inventory screens
  and CRUD do not exist yet.

## Capabilities and Constraints

Confirmed foundation (implemented foundation, see Evidence and ROADMAP.md baseline):

- App shell with translated readiness screen and DB bootstrap
  (`App.tsx`).
- Versioned SQLite migrations, currently schema version 1 with table
  `items(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`.
  See `src/db/migrations.ts`.
- English/Spanish i18n with device-locale detection and English
  fallback. See `src/i18n/`.
- Jest/`jest-expo` unit-test scaffolding with the native boundary
  mocked (`jest.setup.ts`); unit tests never touch a real database.
- A single-session Maestro smoke flow (`.maestro/smoke.yaml`) that
  proves one launch reaches readiness; it does not prove restart
  persistence or locale detection (see README "Tests and their
  limits").
- Source-only GitHub releases; no signing, no EAS, no store upload
  (see README "Quality and automation").

Approved MVP scope (confirmed by the user; not yet built):

- Inventory items carry name, quantity, location, and an optional
  category.
- Operations: create, edit, delete, search.
- Organization principle: inventory by location.

Durable constraints:

- Local-first, single household, on-device only.
- Android/iOS native via Expo React Native + SQLite.
- English/Spanish.
- No backend, no accounts, no sync.
- Native only: `npm run web` fails fast by design.
- Documentation in English to match repository convention.

Explicit non-goals (not approved, not planned in the MVP):

- Backend, accounts, cloud sync, or multi-household sharing.
- Barcode scanning, photos, quantities with units conversion, or
  stock analytics.
- Web version, marketing site, dashboards, or forced tab chrome.

Open decisions (explicitly undecided; DESIGN.md recommends defaults
without claiming approval):

1. Quantity semantics: units, zero, and negative values.
2. Locations: free text vs. a managed list of household places.
3. Categories: free text vs. a small fixed set, and whether search
   filters by category.
4. Deletion and backup: confirm posture and what, if anything, the
   user can recover.

## Brand Commitments

The product name is Tengo. No visual identity, palette, typeface,
icon set, voice-and-tone guide, or marketing claim has been confirmed.
DESIGN.md proposes a direction; nothing there is a brand commitment
until the user approves it.

## Evidence on Hand

- `README.md`: foundation-only scope statement, commands, source
  map, test limits, Maestro boundary, quality/automation notes.
- `App.tsx`: readiness screen and DB bootstrap (`readiness-*`
  testIDs).
- `src/db/index.ts`, `src/db/migrations.ts`: init logic,
  `DATABASE_NAME`, `SCHEMA_VERSION = 1`, v1 `items` schema.
- `src/i18n/index.ts`, `src/i18n/resources.ts`: `en`/`es` resources,
  `resolveLanguage`, `detectDeviceLanguage`.
- `jest.setup.ts`, `__tests__/`: mocked SQL/native boundary and
  unit suites.
- `.maestro/smoke.yaml`: single-session readiness flow.
- `odd/tasks/mobile-foundation.md`: foundation record, including
  native runtime evidence (schema `user_version=1` survives restart;
  CRUD persistence not proven) and the held review state.
- `odd/tasks/product-roadmap-design.md`: the planning task that
  authorizes these documents; documentation only, no implementation.
- Absences future work must not fabricate: no inventory UI, no CRUD
  logic, no search implementation, no store listing, no user
  research or testimonials.

## Product Principles

1. On-device is the feature: every MVP flow must work fully offline.
2. Location first: the place something lives is as important as its
   name.
3. Small and honest: ship the approved fields and operations before
   anything clever.
4. Both languages from day one: no English-only screen or string.
5. Evidence over claims: distinguish implemented foundation from proposed
   design in every document.

## Accessibility & Inclusion

No product-specific accessibility standard has been confirmed. The
planning default (see DESIGN.md) is native platform behavior: system
font scaling, screen-reader labels on every control, minimum touch
targets per OS (44x44 pt iOS, 48x48 dp Android), visible focus and
error states, and honored reduced-motion settings. Spanish is a
first-class language, not a translation pass.
