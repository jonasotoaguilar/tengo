# Roadmap — Tengo inventory by location

Planning document, not a status report. M1 schema/domain and M2 repositories plus
their Android native gates are done, M3 list/search and M4 add/edit/delete are
wired and verified on Android, and M5 hardening is implemented with its criteria
observed and recorded (contrast floor, device metrics, locale, dark mode, large
text, keyboard/safe area, accessibility tree, extended Maestro flows).
"Current" below means read against the working tree (read-only
review; no tests, builds, or installs were run for this document). Companion docs: [PRODUCT.md](PRODUCT.md) (confirmed
product record) and [DESIGN.md](DESIGN.md) (design contract; its section 3 describes built behavior).

## 1. Current baseline (with file evidence)

| Area | State | Evidence |
| ---- | ----- | -------- |
| App shell | Implemented: readiness screen with translated title, subtitle, DB state | `App.tsx` |
| Database | Implemented: `tengo.db`, versioned migrations, schema v6 (items catalog plus stock(item_id, location_id, quantity) with composite PK, quantity > 0, both FKs ON DELETE CASCADE and idx_stock_location_id; locations, categories, item-category join, unique indexes on the folded entity name, partial unique index on the normalized location address) | `src/db/index.ts`, `src/db/migrations.ts` |
| i18n | Implemented: `en`/`es`, device-locale detection, English fallback, type-locked keys | `src/i18n/index.ts`, `src/i18n/resources.ts` |
| Unit tests | Implemented scaffolding: native boundary mocked, never touches a real DB | `jest.setup.ts`, `__tests__/`, `jest.config.js` |
| Native smoke | Minimal: one launch reaches readiness; no restart-persistence or locale proof | `.maestro/smoke.yaml`, [Maestro boundary](docs/testing.md#maestro-boundary) |
| Inventory CRUD | Implemented and Android-verified end to end: repository APIs, the controlled `InventoryList`, the controlled `ItemForm` with its route-epoch controller, the container route/modal wiring behind an explicit `enableMutations` opt-in, and a passing Android form flow over an isolated fixture database. The four Maestro flows were re-observed on the catalog-and-stock model and all pass; the search budget miss of that model is recorded in `docs/testing.md` | `src/inventory/`, `src/components/`, `src/screens/`, [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Native gates | Done: M1 migration 5/5 and M2 persistence phases 5/5, 3/3, 8/8 on Android | [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Releases | Source-only GitHub releases; no signing, EAS, or store upload | [quality commands](docs/development.md#quality-commands) |
| Review/tooling | Every code unit carries its own native review, approved and acknowledged with the authority burned (P1 through P5g, the M4 wiring units and the contrast-token unit); commit, push, PR and merge stay user decisions | `odd/tasks/inventory-mvp.md` |

Authoritative prior record: `odd/tasks/mobile-foundation.md`
(foundation scope, native runtime evidence, held review) and
`odd/tasks/product-roadmap-design.md` (this planning task).

## 2. Goals and non-goals

Goals (approved MVP "Inventory by location"):

1. Create, edit, and delete items carrying a name, per-location stock
   (one quantity per location, 1–999999 each; the total is the sum;
   no stock anywhere shows as "sin stock"),
   and zero or more categories; an item may hold stock in zero, one,
   or several locations. Search items with name search
   as the approved baseline plus multi-category OR filtering with
dedup, extended by the adopted location/category text matching
   (section 9). Deletion always confirms with no trash (location
   deletion cascades stock but never items, each confirmation stating
   the impact); domain
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

Surfaces reviewed at this gate: [DESIGN.md](DESIGN.md) sections 3–4 wireframes
and section 5 tokens; this document's section 9 gate table.

- Review the list, search, add, edit, and location wireframes plus
  the recommended defaults (field limits, backfill values,
  quantity, locations, categories, deletion) and record a user
  decision per gate; the section 9 contract decisions below already
  govern M1/M2, and the wireframe/defaults review recorded in
  section 9 closed this gate before the M3/M4 UI work.
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

- Normalized schema (approved, now v4): `locations` (id, name required,
  address optional, free-entry names such as Casa/Bodega),
  `categories` (independent entities), the `items` catalog (id, name,
  created_at) plus `stock(item_id, location_id, quantity)` with a
  composite primary key, `quantity > 0`, both foreign keys
  `ON DELETE CASCADE` and `idx_stock_location_id`, so one item may
  hold stock in several locations each with its own quantity (the total
  is the sum; no rows anywhere shows as "sin stock"), and an
  `item_categories` join (one row per
  item-category pair, no duplicates) so an item has zero or many
  categories. (M1 built the v2 shape with a single location plus
  `quantity` on `items`; v4 replaced it.) Integrity is enforced by both domain validation and
  database constraints (foreign keys, required fields, join
  uniqueness). Adopted and implemented on 2026-10-12 (section 9):
  numeric/string bounds (name 1–120, quantity 1–999999 per stock row
  with 0-quantity rows dropped, location
  1–80, category 80), name uniqueness, accent-folding semantics,
  and the index choices that carry them (the v3 unique indexes on
  the folded name). Address uniqueness was adopted and is implemented
  (U11): the domain layer folds trim/accent/case and the v6 partial
  unique index on the normalized address carries the case/whitespace
  part, with NULL addresses excluded; entity names stay unique as before.
- Migration policy (approved; the v1→v2 entry stands as the record of
  that earlier migration): v1 rows carry only
  `id`/`name`/`created_at` with no location, and no production v1
  rows have been observed on any device (fixture rows are throwaway). Fixture migration must never silently
  lose rows or fabricate a location (no synthetic `Unassigned`).
  An empty v1 database migrates cleanly and an already-v2 database
  is a no-op; nonempty v1 rows lacking a location preserve rows/version
  and stop with a clear
  migration-required error instead of inventing a location.
  The v4 rebuild carries one stock row per old item with `quantity > 0`
  (an old zero-quantity item becomes catalog-only, "sin stock"),
  aborts with rows and version untouched on any count/sum mismatch,
  and bumps the version in the same transaction with no downgrade.
  The v5 columns are purely additive (no rebuild, no guard); the v6
  partial unique address index is likewise additive but carries the same
  preserve-and-stop guard shape as v3 for pre-existing duplicates
  (`SCHEMA_VERSION = 6`).
- Acceptance: empty, v1-shaped, and already-v2 fixtures behave as
  above with zero silent loss; invalid/missing location or category
  references and duplicate associations are rejected; a 0-quantity
  stock row is dropped rather than stored and invalid quantity rejected; v4 preserves catalog count
  and quantity sum or aborts with rows/version untouched;
  downgrade is out of
  scope and documented.
- Test-first: RED with a migration test on a v1-shaped fixture,
  then GREEN with the migration; TRIANGULATE with empty DB, v1
  rows, already-v2 DB, invalid/missing relationships, duplicate
  associations, 0-quantity rows dropped, and "sin stock" items staying
  visible. Distinct from the fake-boundary
  Jest tests, the migration SQL also runs once against a real
  native SQLite v1 fixture (isolated check, not the Jest suite)
  before M2; that native gate passed on Android and host SQLite
  evidence does not replace it (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- Risk (v1→v2 record): a `NOT NULL` single-location column without a satisfiable value
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

Status: done — bounded `queryItems`, the controlled
`InventoryList` and App integration are wired, and the Android query flow
passed on the isolated fixture database with its device metrics measured
under M5 (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only));
Surfaces: list screen, search field, empty/first-run states,
loading/error states. Design contract: [DESIGN.md](DESIGN.md)
sections 3–4 (list, search, states, tokens).

- List with a general view (each item once, total plus per-location
  breakdown), location views showing that location's quantity (the
  filter is a membership test), and a trailing group for items with
  no stock anywhere ("sin stock"); search matches the
  item name, any location name where it has stock, or any of its category names (adopted and
  implemented on 2026-10-12, section 9) plus the approved multi-category
  OR filtering with dedup.
- Acceptance: empty DB teaches the user how to add the first item
  (not a bare "nothing here"); search is case- and accent-insensitive
  for `en`/`es` by Unicode-lowercase substring matching with NFD accent
  folding (adopted and implemented on 2026-10-12, section 9); loading
  shows skeletons, not a bare spinner; DB error shows retry.
- Test-first (for the pending App integration): RED with
  integration tests for empty, populated, and error states (the
  presentational component cases already exist host-side); GREEN with the screen; TRIANGULATE no-match search
  and very long names.
- UX from the start: this is the first user-visible MVP surface, so
  [DESIGN.md](DESIGN.md) list/search wireframes govern layout.

### M4 — Add, edit, location input, delete (depends on M2, UX from M3)

Status: done — the controlled form, its controller and the container wiring
are implemented, and the Android form flow passed over an isolated fixture
database (see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
Still pending from this area: native proof for typing into a non-empty
numeric quantity field (the flow edits quantity with the stepper). The flows have
since been re-run on the new model and all four pass. The
responsive, theme, keyboard, locale and accessibility checks belong to M5
and are recorded there.
Surfaces: add/edit form screen (or bottom sheet per Android convention),
location input, delete confirmation, validation messages. Design
contract: [DESIGN.md](DESIGN.md) sections 3–5.

- Fields: name, per-location stock editor (one row per location with
  its quantity stepper/input plus remove, add-location with inline
  location creation while saving the item),
  zero or more categories via
  multi-select.
- Acceptance: validation blocks empty names and invalid quantities
  with inline messages in the current language; delete requires
  explicit confirmation and announces the result; form state
  survives keyboard show/hide and rotation without data loss.
- Test-first: RED with validation and delete-confirm component
  tests; GREEN minimal; TRIANGULATE 0-quantity row dropped, whitespace-only
  name, and cancel-mid-edit cases.
- Risk: data loss on dismiss without save; destructive tap without
  confirm.

### M5 — Hardening: a11y, i18n, performance, native matrix (depends on M3–M4)

Status: done — no new features were added. The string audit runs as a
guard, the contrast floor is implemented and guarded, the performance
budgets were measured on device, and the extended Maestro flows (1.0x and
2.0x) plus the manual device passes and the device accessibility tree are
recorded in
[docs/testing.md](docs/testing.md#recorded-m5-contrast-measurements-computed-not-device-sampled).
The one honest product gap is the native quantity-typing case listed
under M4, and TalkBack speech itself is not automatable on this host: the
accessibility evidence is the device tree, stated as such rather than
glossed as a screen-reader pass.

Surfaces: string audit, accessibility labels, performance pass, extended
Maestro flows.

- Full `en`/`es` string audit (no hardcoded UI text, `es` parity via
  the existing type lock).
- Screen-reader pass on every screen and control; 48dp minimum
  touch targets on Android; reduced-motion honored.
- Performance: list stays smooth with a few hundred items on a
  low-end device; search responds per keystroke without blocking.
- Native test matrix: unit Jest (mocked boundary) plus on-device
  checks per section 6; Maestro flows extended beyond the passing M3/M4
  flows on a debug build.
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
  join with a single location per item (v2 shape; v4 replaces it with
  catalog plus stock); v1 rows predate
  those tables and no production v1 rows have been observed on any
  device (fixture rows are throwaway). Never
  silently discard rows and never fabricate a location (no synthetic
  `Unassigned`): nonempty v1 data lacking a location preserves rows/version and blocks migration with an
  explicit migration-required error. Mitigation: fixture-driven
  migration with explicit preserve-and-stop behavior, exercised by
  v1-fixture Jest tests plus the real native SQLite fixture check
  on Android (passed before M2 on the previous model; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
  The v4 rebuild follows the same never-lose/never-fabricate rule under
  its preserve-and-stop guard; its native gate is pending.
- No downgrade path is proposed; document that a v2 database does
  not open cleanly on older code.
- The app provides no backup or sync of its own, so an in-app
  delete is irreversible; that says nothing about OS-level backup
  behavior, which is unknown and must not be promised. M4 requires
  confirmation and DESIGN.md specifies the wording.
- Never interpolate user input into SQL; use bound parameters in
  every new query (M2 acceptance).

## 6. Native test matrix (every row observed on Android, including the v4 re-observation of the four flows; the one gap is typing into a non-empty numeric quantity field)

| Layer | What | Where |
| ----- | ---- | ----- |
| Unit | Migration, validation, repository logic on fakes | `__tests__/` via `npm run test:ci` |
| Type/lint/format | `tsc --noEmit`, Biome check and format | `npm run check` |
| Compat/export | `expo install --check`, unsigned Android export smoke | `npm run compat`, `npm run export:smoke` |
| Device smoke | Single-launch readiness | Maestro on debug build (`com.tengo.app`); see [Maestro boundary](docs/testing.md#maestro-boundary) |
| Add/search/edit/delete flows | Passed on Android: `.maestro/m4-forms.yaml` 97/97 commands, 0 failures, covering empty first-run, create with inline location/category, edit, dirty-discard, delete confirmation and force-stop/relaunch persistence for create, edit and delete | Isolated CRUD fixture; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Large-text flow (2.0x) | Passed on Android: `.maestro/m4-forms-large-text.yaml` 78/78 commands, 0 failures, with 8 explicit `scrollUntilVisible` steps before below-the-fold taps; one honest earlier FAIL (60/61, step-061) exposed the missing scrolls and a caret-dependent `eraseText` on a wrapped name | Isolated CRUD fixture at `font_scale 2.0`; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Native migration | Passed on Android: M1 fixture 5/5 | Isolated native check (not Jest); see [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| CRUD persistence | Passed on Android: phases 5/5, 3/3, 8/8 across force-stop + relaunch | Debug build (`com.tengo.app`); see [verified native evidence](docs/testing.md#verified-native-evidence-android-only) |
| Manual device | Restart persistence, `es` device locale, dark mode, large text, keyboard/safe-area on one Android phone | Emulator or hardware; record which produced the evidence |

Fixture/native rows above are verified (see section 1 and
[verified native evidence](docs/testing.md#verified-native-evidence-android-only));
device metrics, locale detection, accessibility (device accessibility tree),
responsive layout and performance budgets are recorded there as well. Section 9
records the adopted decisions (the managed-entity screen was adopted and
implemented on 2026-10-12); DESIGN.md sections 3–5 describe built behavior and the
approved tokens.

## 7. Cross-cutting requirements (MVP must meet all)

- Search: name matching is the approved baseline; multi-category
  selection filters with OR semantics and deduplicated results;
  location/category text matching was adopted and implemented on
  2026-10-12 (section 9); case- and accent-insensitive in both
  languages with NFD accent folding (adopted and implemented, section
  9); no-match state names the query and offers a clear path.
- Validation (approved): stock rows each reference a valid location
  entity (name required, address optional) with a per-row quantity;
  an item may hold stock in zero, one, or several locations; zero or more categories
  per item with no duplicate associations; a 0-quantity row is dropped
  rather than stored (no-stock items show as "sin stock"); invalid quantity and missing/invalid references
  rejected with inline errors in the current language, next to the
  field. Adopted and implemented on 2026-10-12 (section 9): trimmed
  length/numeric bounds (name 1–120, quantity 1–999999 per stock row
  with 0 dropped, location
  1–80, category 80) and name uniqueness, enforced in the domain and
  backed by the v3 unique indexes. Address uniqueness was never
  adopted and is not implemented.
- Errors: typed domain errors mapped to translated UI copy; DB
  failure shows retry, never raw SQLite text or a blank screen.
- Empty: first-run teaches adding the first item; location views
  with zero matches explain why rather than silently vanishing, and
  items with no stock anywhere appear in the trailing "sin stock"
  group rather than disappearing.
- Accessibility: screen-reader names on all controls; 48dp minimum
  touch targets on Android; visible focus; errors announced;
  reduced-motion honored (crossfade/instant instead of slides/parallax).
  Approved contrast floor, implemented and guarded: text at least
  4.5:1, interactive control boundaries at least 3:1 against both the
  background and the surface (`src/theme/tokens.ts`, guarded by
  `__tests__/contrast-floor.test.tsx`).
- i18n: every user-visible string in `src/i18n/resources.ts` with
  `es` parity; device locale detected at launch with English
  fallback; no hardcoded UI text.
- Performance (budgets, measured on a device pass):
  no blocking queries on the UI thread path; a list of up to 500
  items renders its first viewport in under 1s on a mid-range
  device; search filters within 200ms per keystroke; single-row
  writes complete within 100ms. Measured on emulator-5554 with 500
  seeded items: first-viewport data readiness 222.4ms, single-row
  write 44.9ms, and search per keystroke 292.6ms, which MISSES the
  200ms budget on the catalog-and-stock model and is recorded as a
  FAIL in docs/testing.md rather than waived. The earlier passes —
  200.8ms before the read-shape change, then 174.6ms after it — are
  the history that makes this regression visible, and they are not
  the current figure. Images
  are out of scope, so no image budget applies.

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
| Wireframes + gate defaults reviewed | G0 (before M1) | Recorded 2026-10-12: the boards and DESIGN.md sections 3–5 were reviewed against the built screens, and the entries below are the approved contract. The defaults deferred here were then adopted by the user as the named owner and implemented on 2026-10-12: trimmed bounds, name uniqueness, accent folding, and location/category text matching, each with its review and verification receipt in `odd/tasks/inventory-mvp.md`. The managed-entity screen was then adopted by the user and implemented on 2026-10-12, and address uniqueness was adopted and implemented (domain check plus the v6 partial unique index) |
| Quantity semantics | M1 | Approved: each stock row carries 1–999999; a 0-quantity row is dropped rather than stored and an item with no rows shows as "sin stock". Bounds adopted and implemented (1–999999 per row with 0 dropped, typed `out-of-range`); negatives are rejected by that same bound; units stay out of MVP scope |
| Locations | M1/M4 | Approved: location entity, name required, address optional, free entry; one item may hold stock in several locations and zero locations is a valid state. Name uniqueness adopted and implemented (accent-aware domain check plus the v3 unique index); address uniqueness adopted and implemented (accent-aware domain check plus the v6 partial unique index; NULL addresses never collide; a database holding duplicate addresses refuses to migrate instead of being rewritten); deleting a location cascades its stock rows and never deletes items, with the confirmation stating the impact; `LocationInUseError` no longer exists; the managed-location UI was adopted and implemented on 2026-10-12 |
| Categories | M1/M4 | Approved: independent entities, zero or many per item, multi-select OR filter with dedup. Location/category text matching adopted and implemented; deleting a category removes only the association with items (confirmation states the impact); the management UI was adopted and implemented on 2026-10-12 |
| Deletion/backup | M4 | Approved: confirm every delete, no trash/undo in MVP, irreversibility stated in the dialog; location deletion states how many existencias go (items survive) and category deletion states the association removal; an item is deleted only explicitly, never as a side effect; anything beyond that undecided |

No milestone is complete while its gate decision is unrecorded.

## 10. Delivered reviewable slices

1. M1 migration + validation + tests.
2. M2 repository + tests.
3. M3 list/search/empty + tests.
4. M4 add/edit/delete + tests.
5. M5 hardening evidence (strings, a11y, matrix results).

Each slice keeps tests and strings with the code and stays small
enough to review in one pass. All five were delivered on branch
`feat/inventory-model-v2` under the user's standing order; the
executable slices carry native review lineages and independent
verification receipts recorded in `odd/tasks/inventory-mvp.md`.
The review candidates were kept to exact work units rather than the
accumulated branch.

## 11. MVP completion checklist

- [x] G0: section 9 decisions recorded — quantity, location, category and deletion are approved user decisions, and the wireframe/defaults review is recorded with the remaining defaults deferred to the user as the named owner. M3/M4 shipped against those decisions.
- [x] M1: normalized locations/categories/item-category schema (v2 shape
  with a single location per item, since replaced by the v4
  catalog-plus-stock schema; see section 1); empty, v1-shaped, and
  already-v2 fixtures behave per the preserve-and-stop migration
  policy on the fake boundary and in the real native SQLite fixture
  check on Android (passed on the previous model; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only));
  validation rules tested including 0-quantity rows dropped with
  "sin stock" staying visible,
  invalid/missing references, and duplicate associations.
- [x] M2: CRUD repository with parameterized SQL; error mapping
  tested; create/edit/delete survive force-stop + relaunch on a
  debug build (passed on Android; see [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- [x] M3: list/search/empty/loading/error states per DESIGN.md, verified on Android: 9/9 native query checks, and `m3-query.yaml` re-observed green on the catalog-and-stock model at 108 commands with zero failures (it had been 72/72 on the previous model and 78/78 after the cross-entity search change). The device metrics are recorded under M5, where the search figure currently MISSES its budget and is recorded as a FAIL rather than waived.
- [x] M4: add/edit/delete with validation and confirm; no silent
  data loss. Verified on Android: inline entity creation,
  dirty-discard Cancel/Discard and delete confirmation observed, and
  create, edit and delete all survived force-stop + relaunch on an
  isolated fixture database (no production data touched; the flows were
  re-observed on v4 and all pass, with the search budget miss recorded in
  `docs/testing.md`); see
  [verified native evidence](docs/testing.md#verified-native-evidence-android-only).
- [x] M5: `en`/`es` audit (guard), accessibility-tree pass with 48dp targets, contrast floor implemented and guarded, performance budgets measured on a device pass where the search budget is currently MISSED and recorded as a FAIL rather than waived, and extended Maestro flows (1.0x 97/97, 2.0x 78/78) observed on a debug build. TalkBack speech is a stated boundary, not claimed.
- [x] Section 9 recorded and then closed by adoption: the approved quantity/location/category/deletion entries stay approved, and the defaults deferred to the user as the named owner were adopted on 2026-10-12 and implemented — trimmed bounds, name uniqueness, accent folding, and location/category text matching — each with its review and verification receipt in `odd/tasks/inventory-mvp.md`. The managed-entity screen was then adopted by the user and implemented on 2026-10-12, so no adopted proposal remains unimplemented; address uniqueness was adopted and is implemented (U11).
- [x] No backend/accounts/sync introduced; `npm run web` still fails fast
  (`node -e` exits 1) and releases stay source-only (`release.yml` on tag `v*`).
