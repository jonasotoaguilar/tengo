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
exists so a household can record items with a name and per-location
stock (each location holding its own quantity, plus zero or more
categories), then
later find, update, or remove them without depending on a network,
account, or server. A stock row always means something is stored
there (quantity > 0); an item with no stock rows anywhere stays
visible as "sin stock" rather than disappearing. One item can hold
stock in several locations and its total is the sum. Locations are
entities (name required, address optional,
free-entry names such as Casa/Bodega); categories are independent
entities joined to items. Deletion always requires confirmation and
there is no trash. Domain models and the database both enforce these
integrity rules.

Success for the approved MVP means the user can create, edit, delete,
and search items entirely on-device, in English or Spanish. Search by
name is the approved baseline; multi-category selection filters with
OR semantics and deduplicated results. Location/category text matching
and accent folding were adopted and implemented on 2026-10-12 (open
decision 3).

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
- The default screen is the wired inventory list backed by the
  on-device database, with add/edit behind the same container. The
  list shows each item once with its total and per-location breakdown
  (plus a trailing "sin stock" group); the form edits per-location
  stock rows and can still create a location inline while saving the
  item. The new-model UI is host-verified (unit suites,
  `npm run check`) and the four Maestro flows were re-observed on it, all
  passing; the search budget miss of the new model is recorded in
  `docs/testing.md`.

## Capabilities and Constraints

Confirmed foundation (implemented foundation, see Evidence and ROADMAP.md baseline):

- App shell with translated readiness screen and DB bootstrap
  (`App.tsx`).
- Versioned SQLite migrations, currently schema version 6 (v6 adds
  the partial unique index on the normalized location address; v5 added
  the barcode/expiry/reminder columns; v4 splits
  the catalog from per-location stock; v3 added
  the unique indexes on the folded entity name):
  the `items` catalog (`id`, `name`, `created_at`) plus
  `stock(item_id, location_id, quantity)` with a composite primary
  key, `quantity > 0`, both foreign keys `ON DELETE CASCADE` and
  `idx_stock_location_id`, alongside `locations`, `categories`,
  and the `item_categories` join.
  See `src/db/migrations.ts`. The M1/M2 native gates passed on
  Android on the previous model (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only));
  on v6 the schema is verified by 66 checks against real host SQLite, and
  the M1/M2 gate scripts themselves have not been re-run on a device.
- English/Spanish i18n with device-locale detection and English
  fallback. See `src/i18n/`.
- Jest/`jest-expo` unit-test scaffolding with the native boundary
  mocked (`jest.setup.ts`); unit tests never touch a real database.
- A single-session Maestro smoke flow (`.maestro/smoke.yaml`) that
  proves one launch reaches readiness; it does not prove restart
  persistence or locale detection (see
  [Maestro boundary](docs/testing.md#maestro-boundary)).
- Source-only GitHub releases (see [quality commands](docs/development.md#quality-commands)).
  Distribution preparation exists (`eas.json`, release fields in
  `app.json`, `docs/distribution.md`); no EAS project is linked,
  nothing has been built by EAS, nothing has been uploaded, and
  signing is undecided.

Approved MVP scope (confirmed by the user; repository APIs implemented, product UI pending M3/M4):

- Inventory items carry a name and zero or more stock rows, one per
  location each with its own quantity (1–999999; the total is the
  sum). An item with no stock rows anywhere stays visible as
  "sin stock" rather than disappearing.
- Locations are entities: name required,
  address optional, free-entry names such as Casa/Bodega. An item may
  hold stock in zero, one, or several locations; zero locations is a
  valid state.
- Categories are independent entities; an item has zero or many
  categories via a join. Selecting several categories filters with
  OR semantics and deduplicated results.
- Operations: create, edit, delete (always confirmed, no trash),
  search.
- Organization principle: inventory by location.
- Integrity is enforced by both domain models and the database.
- M1 uses a normalized schema (locations, categories, catalog items,
  per-location stock, and an
  item-category join);
  see ROADMAP.md. No production v1 rows have been observed on any
  device (fixture rows are throwaway). Migration must never silently lose rows or fabricate a
  location: the v4 rebuild carries one stock row per old item with
  `quantity > 0` (an old zero-quantity item becomes catalog-only,
  "sin stock") under a preserve-and-stop guard, with no downgrade;
  the v1 rule (nonempty v1 rows lacking a location preserve
  rows/version and stop with a migration-required error) stands as the
  record of that earlier migration. The native SQLite gate passed on
  Android before M2 on the previous model (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only));
  the v4 native gate is pending.

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

1. Quantity bounds and units: each stock row carries 1–999999; a
   0-quantity row is dropped rather than stored, and an item with no
   rows shows as "sin stock"; units stay out of MVP scope. Numeric/string
   bounds were adopted and implemented on 2026-10-12 (name 1–120,
   quantity 1–999999 per stock row with 0 dropped, location 1–80,
   category 80), and negatives are
   rejected by that same bound.
2. Locations: the location entity (name required, address
   optional, free entry) is approved; one item may hold stock in
   several locations and zero locations is a valid state; name uniqueness was adopted and
   implemented on 2026-10-12. Deleting a location cascades its stock
   rows and never deletes items; the confirmation states the impact
   (how many existencias); `LocationInUseError` no longer exists.
   Address uniqueness was adopted and is implemented: the domain layer
   rejects a duplicate address after trim/accent/case normalization with a
   typed conflict, and the database enforces the case/whitespace part with
   the v6 partial unique index (NULL addresses never collide, so many
   address-less locations stay legal). A database that already holds
   duplicate addresses refuses to migrate instead of being rewritten.
   The managed-location UI was
   adopted by the user and implemented on 2026-10-12 and is now observed on
   the device through the entity flow, which exercises create, rename and
   delete with its impact confirmation; TalkBack speech on that screen
   remains unobserved.
3. Categories: independent entities, zero or many per item, with
   OR-plus-dedup multi-select filtering, are approved; location and
   category text matching was adopted and implemented on 2026-10-12.
   Deleting a category removes only the association with items (items
   survive); the confirmation states the impact. The category management
   UI was adopted and implemented on 2026-10-12 and is observed on the device
   through the same flow.
4. Backup/recovery: deletion posture is approved (always confirm, no
   trash); anything beyond that is undecided. Accent handling was
   adopted and implemented on 2026-10-12, and the contrast and
   placeholder semantics in DESIGN.md are implemented and guarded by
   `__tests__/contrast-floor.test.tsx`. The managed-entity screen was
   adopted by the user and implemented on 2026-10-12, and address
   uniqueness was adopted and is implemented (domain check plus the v6
   partial unique index, with a loud migration block instead of a silent
   rewrite when duplicates already exist), so no adopted proposal remains
   unimplemented in this area.

## Brand Commitments

The product name is Tengo. The token values and contrast floors DESIGN.md
records are approved and implemented (its section 5, guarded by
`__tests__/contrast-floor.test.tsx`). Under the user's blanket order, this
phase additionally chooses and ships a first identity: an app icon, an
Android adaptive icon (foreground, background and monochrome), a splash
screen and a favicon, all rendered deterministically in-repo by
`scripts/generate-assets.mjs` (`npm run generate:assets`) from the approved
token palette in `src/theme/tokens.ts` — a light-accent (`#2F6B3A`) tile
carrying an `accentOn` bin-and-shelves mark, with the splash mark drawn in
accent over the light `surface` (`#F4F2EC`). Still unconfirmed: no designer
has approved the mark, and there is no voice-and-tone guide, no marketing
claim and no typography decision. DESIGN.md records the reasoning and the
palette derivation.

## Evidence on Hand

- `README.md`: scope statement and links; detail lives in
  [docs/development.md](docs/development.md) (setup, source map,
  quality) and [docs/testing.md](docs/testing.md) (test limits,
  native protocol, Maestro boundary).
- `App.tsx`: readiness screen and DB bootstrap (`readiness-*`
  testIDs); the default screen is still readiness and the fixture
  branches are DEV-only.
- `src/db/index.ts`, `src/db/migrations.ts`: init logic,
  `DATABASE_NAME`, `SCHEMA_VERSION = 6`, v6
  catalog-plus-stock schema with the partial unique address index
  (earlier shapes retained in the migration ladder).
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
  UI, no App-wired list/search, no store submission, no user
  research or testimonials. (Repository and bounded-query logic
  exist in `src/inventory/`; they are not product UI. A store
  listing *draft* exists in `docs/distribution.md`; it is not a
  submitted listing.)

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
