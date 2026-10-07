# Roadmap — Tengo inventory by location

Planning document, not a status report. The MVP product UI is
approved but not built: M1 schema/domain and M2 repositories plus
their Android native gates are done, while M3 App integration, M4
forms, and M5 hardening stay pending. "Current" below means read against the working tree (read-only
review; no tests, builds, or installs were run for this document). Companion docs: [PRODUCT.md](PRODUCT.md) (confirmed
product record) and [DESIGN.md](DESIGN.md) (proposed UX, not implemented).

## 1. Current baseline (with file evidence)

| Area | State | Evidence |
| ---- | ----- | -------- |
| App shell | Implemented: readiness screen with translated title, subtitle, DB state | `App.tsx` |
| Database | Implemented: `tengo.db`, versioned migrations, schema v2 (locations, categories, items with required location reference and quantity, item-category join) | `src/db/index.ts`, `src/db/migrations.ts` |
| i18n | Implemented: `en`/`es`, device-locale detection, English fallback, type-locked keys | `src/i18n/index.ts`, `src/i18n/resources.ts` |
| Unit tests | Implemented scaffolding: native boundary mocked, never touches a real DB | `jest.setup.ts`, `__tests__/`, `jest.config.js` |
| Native smoke | Minimal: one launch reaches readiness; no restart-persistence or locale proof | `.maestro/smoke.yaml`, [Maestro boundary](docs/testing.md#maestro-boundary) |
| Inventory CRUD | Repository APIs implemented and Android-verified; no screens yet: the controlled `InventoryList` and bounded `queryItems` exist but are not wired into `App.tsx` (M3/M4 pending) | `src/inventory/`, `src/components/InventoryList.tsx`, [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Native gates | Done: M1 migration 5/5 and M2 persistence phases 5/5, 3/3, 8/8 on Android | [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Releases | Source-only GitHub releases; no signing, EAS, or store upload | [quality commands](docs/development.md#quality-commands) |
| Review/tooling | Prior native review held per user instruction; work-unit commits pending authorization | `odd/tasks/mobile-foundation.md` |

Authoritative prior record: `odd/tasks/mobile-foundation.md`
(foundation scope, native runtime evidence, held review) and
`odd/tasks/product-roadmap-design.md` (this planning task).

## 2. Goals and non-goals

Goals (approved MVP "Inventory by location"):

1. Create, edit, and delete items carrying name, quantity
   (zero means exhausted), a required location-entity reference,
   and zero or more categories; search items with name search
   as the approved baseline plus multi-category OR filtering with
dedup (further location/category text matching proposed,
   see section 9). Deletion always confirms with no trash; domain
   and database both enforce integrity.
2. Browse and search organized around location.
3. Fully offline, on-device, in English and Spanish.
4. Native-feeling Android UI from the start (see
   [DESIGN.md](DESIGN.md)).

Non-goals (explicitly out of the MVP):

- Backend, accounts, sync, sharing, multi-household support.
- Barcode scanning, photos, unit conversion, analytics/dashboards.
- Web build, marketing site, store release (distribution stays at the
  stage gate in section 8).

## 3. Dependency-ordered milestones

UI is considered from the start: G0 wireframe and product-gate review
precedes any schema work in M1, and no milestone builds behavior
without its [DESIGN.md](DESIGN.md) states (loading, empty, error,
destructive-confirm). Milestone order is dependency order; do not
reorder without re-checking the "depends on" chain.

### G0 — UX/product gates and wireframe review (before M1, no schema work first)

Proposed surfaces: [DESIGN.md](DESIGN.md) sections 3–4 wireframes
and section 5 tokens; this document's section 9 gate table.

- Review the list, search, add, edit, and location wireframes plus
  the recommended defaults (field limits, backfill values,
  quantity, locations, categories, deletion) and record a user
  decision per gate; the section 9 contract decisions below already
  govern M1/M2, and full wireframe review still gates M3/M4 UI work.
- Acceptance: every gate in section 9 has an explicit user decision
  (adopt, amend, or defer with a named owner); DESIGN.md wireframes
  reviewed with no open layout or state contradiction before UI
  milestones build screens.
- UI-from-start rule: M1 field limits, backfill values, and index
  choices must match the reviewed wireframes; a schema change that
  alters the form or list returns to the wireframes first.

### M0 — Recorded baseline (completeness not verified; no work proposed)

Record only. Section 1 is the recorded baseline; its completeness is
not verified here. Nothing to build; future milestones must preserve
the mocked native test boundary and the versioned-migration
discipline.

### M1 — Data model and migration v2 (depends on M0)

Status: done — schema, validation, Jest suites, and the Android
native fixture gate all pass (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
Surfaces: `src/db/migrations.ts` (v2 migration), domain types
plus validation (`src/inventory/`), Jest suites for migration
and validation.

- Normalized M1 schema (approved): `locations` (id, name required,
  address optional, free-entry names such as Casa/Bodega),
  `categories` (independent entities), `items` with a required
  `location_id` foreign key plus `quantity` (zero allowed and
  meaning exhausted), and an `item_categories` join (one row per
  item-category pair, no duplicates) so an item has zero or many
  categories. Integrity is enforced by both domain validation and
  database constraints (foreign keys, required fields, join
  uniqueness). Still proposals, not approvals: numeric/string
  bounds (such as 120/80/999999), name/address uniqueness, index
  choices, and accent-folding semantics.
- Migration policy (approved): v1 rows carry only
  `id`/`name`/`created_at` with no location, and no production v1
  rows have been observed on any device (fixture rows are throwaway). Fixture migration must never silently
  lose rows or fabricate a location (no synthetic `Unassigned`).
  An empty v1 database migrates cleanly and an already-v2 database
  is a no-op; nonempty v1 rows that cannot satisfy the required
  location preserve rows/version and stop with a clear
  migration-required error instead of inventing a location.
- Acceptance: empty, v1-shaped, and already-v2 fixtures behave as
  above with zero silent loss; invalid/missing location or category
  references and duplicate associations are rejected; zero quantity
  is accepted and invalid quantity rejected; downgrade is out of
  scope and documented.
- Test-first: RED with a migration test on a v1-shaped fixture,
  then GREEN with the migration; TRIANGULATE with empty DB, v1
  rows, already-v2 DB, invalid/missing relationships, duplicate
  associations, and zero quantity. Distinct from the fake-boundary
  Jest tests, the migration SQL also runs once against a real
  native SQLite v1 fixture (isolated check, not the Jest suite)
  before M2; that native gate passed on Android and host SQLite
  evidence does not replace it (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- Risk: a `NOT NULL` location reference without a satisfiable value
  makes the migration statement fail; the failure alone does not
  wipe existing data, but careless retries, table rebuilds, or
  fabricated backfills can. See section 5.

### M2 — Local CRUD repository (depends on M1)

Status: done — repository module, Jest suites, and Android
persistence across force-stop/relaunch pass (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
Surfaces: repository module (create/read/update/delete with
parameterized SQL, no ORM), Jest suites against the fake DB boundary.

- Parameterized queries only; no string-interpolated user input.
- Acceptance: create returns the new row; read lists and fetches by
  id; update persists edits; delete removes exactly one row; all
  errors surface as typed domain errors, never raw SQLite text.
- Test-first: RED per operation on the fake boundary, GREEN minimal
  implementation, TRIANGULATE not-found, empty-name, and
  invalid-quantity cases.
- Persistence proof (native, isolated, distinct from Jest fakes):
  after create, edit, and delete on a debug build, force-stop and
  relaunch; the new rows, edits, and deletions survive. Recorded
  separately from the schema-survival evidence already on file.
- Risk: SQL injection via interpolation; silent failure on
  constraint violation.

### M3 — Inventory list, search, and empty states (depends on M2)

Status: in progress — bounded `queryItems` and the controlled
`InventoryList` are host-verified only; App integration, native UI
proof (FAB, real SQLite query), and device metrics stay pending.
Proposed surfaces: list screen, search field, empty/first-run states,
loading/error states. Design contract: [DESIGN.md](DESIGN.md)
sections 3–4 (list, search, states, tokens).

- List grouped or filterable by location entities; search matches name
  plus approved multi-category OR filtering with dedup (further
  location/category text matching per the adopted decision in
  section 9).
- Acceptance: empty DB teaches the user how to add the first item
  (not a bare "nothing here"); search is case-insensitive for
  `en`/`es` with accent folding per the adopted gate decision
  (section 9); loading shows skeletons, not a
  bare spinner; DB error shows retry.
- Test-first (for the pending App integration): RED with
  integration tests for empty, populated, and error states (the
  presentational component cases already exist host-side); GREEN with the screen; TRIANGULATE no-match search
  and very long names.
- UX from the start: this is the first user-visible MVP surface, so
  [DESIGN.md](DESIGN.md) list/search wireframes govern layout.

### M4 — Add, edit, location input, delete (depends on M2, UX from M3)

Proposed surfaces: add/edit form screen (or bottom sheet per Android convention),
location input, delete confirmation, validation messages. Design
contract: [DESIGN.md](DESIGN.md) sections 3–5.

- Fields: name, quantity stepper/input, required location entity
  (name required, address optional), zero or more categories via
  multi-select.
- Acceptance: validation blocks empty names and invalid quantities
  with inline messages in the current language; delete requires
  explicit confirmation and announces the result; form state
  survives keyboard show/hide and rotation without data loss.
- Test-first: RED with validation and delete-confirm component
  tests; GREEN minimal; TRIANGULATE zero quantity, whitespace-only
  name, and cancel-mid-edit cases.
- Risk: data loss on dismiss without save; destructive tap without
  confirm.

### M5 — Hardening: a11y, i18n, performance, native matrix (depends on M3–M4)

No new features. Proposed surfaces: string audit, accessibility
labels, performance pass, extended Maestro flows.

- Full `en`/`es` string audit (no hardcoded UI text, `es` parity via
  the existing type lock).
- Screen-reader pass on every screen and control; 48dp minimum
  touch targets on Android; reduced-motion honored.
- Performance: list stays smooth with a few hundred items on a
  low-end device; search responds per keystroke without blocking.
- Native test matrix: unit Jest (mocked boundary) plus on-device
  checks per section 6; Maestro flows extended to add/search/edit/
  delete on a debug build.
- Acceptance: criteria in sections 6–7 all observed; any failure is
  recorded, not waived.

## 4. Test-first strategy (for later behavior changes)

Applies when implementation is authorized. Documentation-only work
has no meaningful RED/GREEN.

1. RED: add the smallest behavior-level test (Jest unit for
   data/domain; component test for UI states) and capture its
   intended failure.
2. GREEN: implement the minimum change; capture the focused pass.
3. TRIANGULATE: negative and alternate cases that protect the
   contract (not-found, invalid input, empty DB, migration from v1).
4. REFACTOR: clarify only while focused tests stay green.

Focused tests first; broad suites only when the parent authorizes
them. Fixed runners (already in `package.json`): `npm test`,
`npm run test:ci`, `npm run typecheck`, `npm run check`,
`maestro test .maestro/smoke.yaml` (debug build only).

## 5. Migration and data-loss risks

- v1→v2 normalizes to locations, categories, and the item-category
  join with a required item-location reference; v1 rows predate
  those tables and no production v1 rows have been observed on any
  device (fixture rows are throwaway). Never
  silently discard rows and never fabricate a location (no synthetic
  `Unassigned`): nonempty v1 data that cannot satisfy the required
  location preserves rows/version and blocks migration with an
  explicit migration-required error. Mitigation: fixture-driven
  migration with explicit preserve-and-stop behavior, exercised by
  v1-fixture Jest tests plus the real native SQLite fixture check
  on Android (passed before M2; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- No downgrade path is proposed; document that a v2 database does
  not open cleanly on older code.
- The app provides no backup or sync of its own, so an in-app
  delete is irreversible; that says nothing about OS-level backup
  behavior, which is unknown and must not be promised. M4 requires
  confirmation and DESIGN.md specifies the wording.
- Never interpolate user input into SQL; use bound parameters in
  every new query (M2 acceptance).

## 6. Native test matrix (fixtures verified; UI/E2E pending)

| Layer | What | Where |
| ----- | ---- | ----- |
| Unit | Migration, validation, repository logic on fakes | `__tests__/` via `npm run test:ci` |
| Type/lint/format | `tsc --noEmit`, Biome check and format | `npm run check` |
| Compat/export | `expo install --check`, unsigned Android export smoke | `npm run compat`, `npm run export:smoke` |
| Device smoke | Single-launch readiness (the only passing Maestro flow today) | Maestro on debug build (`com.tengo.app`); see [Maestro boundary](docs/testing.md#maestro-boundary) |
| Add/search/edit/delete flows | Pending: not available as Maestro flows yet | Planned; no commands documented until the flows exist |
| Native migration | Passed on Android: M1 fixture 5/5 | Isolated native check (not Jest); see [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| CRUD persistence | Passed on Android: phases 5/5, 3/3, 8/8 across force-stop + relaunch | Debug build (`com.tengo.app`); see [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Manual device | Restart persistence, `es` device locale, dark mode, large text, keyboard/safe-area on one Android phone | Emulator or hardware; record which produced the evidence |

Fixture/native rows above are verified (see section 1 and
[verified native evidence](docs/testing.md#verified-native-evidence-android-only));
UI flows, device metrics, and extended Maestro E2E stay pending.
Sections 3–5 record what is proposed.

## 7. Cross-cutting requirements (MVP must meet all)

- Search: name matching is the approved baseline; multi-category
  selection filters with OR semantics and deduplicated results;
  further location/category text matching follows the adopted
  decision (section 9); case- and
  accent-insensitive in both languages (accent folding stays a
  proposal until adopted); no-match state names the
  query and offers a clear path.
- Validation (approved): every item references a valid location
  entity (name required, address optional); zero or more categories
  per item with no duplicate associations; quantity zero accepted
  as exhausted; invalid quantity and missing/invalid references
  rejected with inline errors in the current language, next to the
  field. Still proposals, not approvals: trimmed length/numeric
  bounds (such as name 1–120, quantity 0–999999, location 1–80,
  category max 80), name/address uniqueness, and index choices.
- Errors: typed domain errors mapped to translated UI copy; DB
  failure shows retry, never raw SQLite text or a blank screen.
- Empty: first-run teaches adding the first item; location groups
  with zero items explain why rather than silently vanishing.
- Accessibility: screen-reader names on all controls; 48dp minimum
  touch targets on Android; visible focus; errors announced; reduced-motion
  honored (crossfade/instant instead of slides/parallax). Proposed
  contrast floor, unmeasured until a device pass: text at least
  4.5:1, interactive controls at least 3:1 against adjacent colors.
- i18n: every user-visible string in `src/i18n/resources.ts` with
  `es` parity; device locale detected at launch with English
  fallback; no hardcoded UI text.
- Performance (proposed budgets, unmeasured until a device pass):
  no blocking queries on the UI thread path; a list of up to 500
  items renders its first viewport in under 1s on a mid-range
  device; search filters within 200ms per keystroke; single-row
  writes complete within 100ms. Images are out of scope, so no
  image budget applies.

## 8. Distribution stage (no store release proposed)

The pipeline stays source-only (`release.yml` on tag `v*`): `git
archive` tarball plus unsigned export bundle; tag must equal
`v<package.json version>`. No signing, no EAS, no store upload. If a
future step proposes store distribution, it needs explicit user
choices first: Google Play internal track
vs. production, signing ownership, and whether review screenshots
come from emulator or hardware. None of these is decided.

## 9. Decision gates (must close before or during build)

| Gate | Closes in | Status |
| ---- | --------- | ------ |
| Wireframes + gate defaults reviewed | G0 (before M1) | Proposed: review DESIGN.md wireframes; adopt, amend, or defer each remaining default with a named owner (delivery of boards alone does not complete this gate) |
| Quantity semantics | M1 | Approved: zero allowed meaning exhausted, distinct UI deferred; bounds/units/negatives remain proposed |
| Locations | M1/M4 | Approved: mandatory location entity, name required, address optional, free entry; uniqueness and managed-location UI remain proposed |
| Categories | M1/M4 | Approved: independent entities, zero or many per item, multi-select OR filter with dedup; management UI and further text matching remain proposed |
| Deletion/backup | M4 | Approved: confirm every delete, no trash/undo in MVP, irreversibility stated in the dialog; anything beyond that undecided |

No milestone is complete while its gate decision is unrecorded.

## 10. Proposed reviewable slices (no commit authorized)

1. M1 migration + validation + tests.
2. M2 repository + tests.
3. M3 list/search/empty + tests.
4. M4 add/edit/delete + tests.
5. M5 hardening evidence (strings, a11y, matrix results).

Each slice keeps tests and strings with the code and stays small
enough to review in one pass.

## 11. MVP completion checklist

- [ ] G0: section 9 contract decisions recorded (quantity, location,
  category, deletion entries are approved); full wireframe review
  still gates M3/M4 UI work.
- [x] M1: normalized locations/categories/item-category schema with
  required item-location relationship; empty, v1-shaped, and
  already-v2 fixtures behave per the preserve-and-stop migration
  policy on the fake boundary and in the real native SQLite fixture
  check on Android (passed; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only));
  validation rules tested including zero quantity,
  invalid/missing references, and duplicate associations.
- [x] M2: CRUD repository with parameterized SQL; error mapping
  tested; create/edit/delete survive force-stop + relaunch on a
  debug build (passed on Android; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- [ ] M3: list/search/empty/loading/error states per DESIGN.md.
- [ ] M4: add/edit/delete with validation and confirm; no silent
  data loss.
- [ ] M5: `en`/`es` audit, screen-reader pass, contrast floor and
  performance budgets observed on a device pass, extended Maestro
  flows observed on a debug build.
- [ ] All four open gates in section 9 recorded as user decisions;
  approved quantity/location/category/deletion entries stay approved
  while bounds, uniqueness, management UI, and accent semantics stay
  proposed.
- [ ] No backend/accounts/sync introduced; web still fails fast;
  releases still source-only.
