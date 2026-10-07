# Product

<!-- impeccable:product-schema 1 -->

## Platform

Android only.

One Android product following Material Design 3 conventions, built
from a single Expo React Native codebase. Other platforms are outside
the current scope: not a delivery criterion, blocker, or pending task.

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
a required location entity (plus zero or more categories), then
later find, update, or remove them without depending on a network,
account, or server. Quantity zero is approved and means exhausted;
its distinct UI treatment is deferred to UI milestones. Every item
references a valid location entity (name required, address optional,
free-entry names such as Casa/Bodega); categories are independent
entities joined to items. Deletion always requires confirmation and
there is no trash. Domain models and the database both enforce these
integrity rules.

Success for the approved MVP means the user can create, edit, delete,
and search items entirely on-device, in English or Spanish. Search by
name is the approved baseline; multi-category selection filters with
OR semantics and deduplicated results. Other location/category text
matching is proposed and undecided (see open decision 3).

## Positioning

The meaningfully different mechanism is deliberate smallness: one
household, one on-device SQLite database, no backend, no accounts, no
sync by design. The app itself sends data nowhere. That is not a
guarantee about OS-level backup or other device behavior outside the
app, which is unknown and must not be promised.

## Operating Context

- The app runs natively on Android via Expo React Native.
- The database is on-device SQLite (`expo-sqlite`, database
  `tengo.db`), opened and migrated at launch. See `src/db/index.ts`
  and `src/db/migrations.ts`.
- The device locale selects English or Spanish at launch via
  `expo-localization`; `es` is type-locked to `en` so keys cannot
  drift. See `src/i18n/index.ts` and `src/i18n/resources.ts`.
- The default screen is still the readiness screen in `App.tsx`
  (translated title, subtitle, DB bootstrap state). Behind it, M1
  domain validation, the M2 location/category/item repositories,
  the bounded `queryItems` filter, and the controlled
  `InventoryList` component are implemented but not wired into the
  app: no Add/Edit product UI exists yet (M3/M4 pending).

## Capabilities and Constraints

Confirmed foundation (implemented foundation, see Evidence and ROADMAP.md baseline):

- App shell with translated readiness screen and DB bootstrap
  (`App.tsx`).
- Versioned SQLite migrations, currently schema version 2:
  `locations`, `categories`, `items` (required `location_id`
  reference plus `quantity`), and the `item_categories` join.
  See `src/db/migrations.ts`. The M1/M2 native gates passed on
  Android (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- English/Spanish i18n with device-locale detection and English
  fallback. See `src/i18n/`.
- Jest/`jest-expo` unit-test scaffolding with the native boundary
  mocked (`jest.setup.ts`); unit tests never touch a real database.
- A single-session Maestro smoke flow (`.maestro/smoke.yaml`) that
  proves one launch reaches readiness; it does not prove restart
  persistence or locale detection (see
  [Maestro boundary](docs/testing.md#maestro-boundary)).
- Source-only GitHub releases; no signing, no EAS, no store upload
  (see [quality commands](docs/development.md#quality-commands)).

Approved MVP scope (confirmed by the user; repository APIs implemented, product UI pending M3/M4):

- Inventory items carry name and quantity (zero means exhausted).
- Every item references a valid location entity: name required,
  address optional, free-entry names such as Casa/Bodega.
- Categories are independent entities; an item has zero or many
  categories via a join. Selecting several categories filters with
  OR semantics and deduplicated results.
- Operations: create, edit, delete (always confirmed, no trash),
  search.
- Organization principle: inventory by location.
- Integrity is enforced by both domain models and the database.
- M1 uses a normalized schema (locations, categories, and an
  item-category join with a required item-location relationship);
  see ROADMAP.md. No production v1 rows have been observed on any
  device (fixture rows are throwaway). Migration must never silently lose rows or fabricate a
  location: nonempty v1 rows that cannot satisfy the required
  location preserve rows/version and stop with a clear
  migration-required error. The native SQLite gate passed on
  Android before M2 (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).

Durable constraints:

- Local-first, single household, on-device only.
- Android native via Expo React Native + SQLite.
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

1. Quantity bounds and units: zero is approved as exhausted with UI
   treatment deferred; units, negatives, and numeric/string bounds
   (such as 120/80/999999) remain proposals.
2. Locations: the mandatory location entity (name required, address
   optional, free entry) is approved; name/address uniqueness and any
   managed-location UI remain proposals.
3. Categories: independent entities, zero or many per item, with
   OR-plus-dedup multi-select filtering, are approved; category
   management UI and any further text matching remain proposals.
4. Backup/recovery: deletion posture is approved (always confirm, no
   trash); anything beyond that is undecided. Field limits, accent
   handling, and contrast/placeholder semantics in DESIGN.md remain
   proposals, not approvals.

## Brand Commitments

The product name is Tengo. No visual identity, palette, typeface,
icon set, voice-and-tone guide, or marketing claim has been confirmed.
DESIGN.md proposes a direction; nothing there is a brand commitment
until the user approves it.

## Evidence on Hand

- `README.md`: scope statement and links; detail lives in
  [docs/development.md](docs/development.md) (setup, source map,
  quality) and [docs/testing.md](docs/testing.md) (test limits,
  native protocol, Maestro boundary).
- `App.tsx`: readiness screen and DB bootstrap (`readiness-*`
  testIDs); the default screen is still readiness and the fixture
  branches are DEV-only.
- `src/db/index.ts`, `src/db/migrations.ts`: init logic,
  `DATABASE_NAME`, `SCHEMA_VERSION = 2`, v2
  locations/categories/items/join schema.
- `src/i18n/index.ts`, `src/i18n/resources.ts`: `en`/`es` resources,
  `resolveLanguage`, `detectDeviceLanguage`.
- `jest.setup.ts`, `__tests__/`: mocked SQL/native boundary and
  unit suites.
- `.maestro/smoke.yaml`: single-session readiness flow.
- `odd/tasks/mobile-foundation.md`: historical planning record
  (foundation scope and held review; its v1-era native notes are
  superseded by [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- `odd/tasks/product-roadmap-design.md`: the planning task that
  authorizes these documents; documentation only, no implementation.
- Absences future work must not fabricate: no Add/Edit inventory
  UI, no App-wired list/search, no store listing, no user
  research or testimonials. (Repository and bounded-query logic
  exist in `src/inventory/`; they are not product UI.)

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
targets (48x48 dp minimum on Android), visible focus and
error states, and honored reduced-motion settings. Spanish is a
first-class language, not a translation pass.
