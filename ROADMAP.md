# Roadmap — Tengo inventory by location

Planning document, not a status report. The MVP is approved but not
built. "Current" below means read against the working tree (read-only
review; no tests, builds, or installs were run for this document). Companion docs: [PRODUCT.md](PRODUCT.md) (confirmed
product record) and [DESIGN.md](DESIGN.md) (proposed UX, not implemented).

## 1. Current baseline (with file evidence)

| Area | State | Evidence |
| ---- | ----- | -------- |
| App shell | Implemented: readiness screen with translated title, subtitle, DB state | `App.tsx` |
| Database | Implemented: `tengo.db`, versioned migrations, schema v1 `items(id, name, created_at)` | `src/db/index.ts`, `src/db/migrations.ts` |
| i18n | Implemented: `en`/`es`, device-locale detection, English fallback, type-locked keys | `src/i18n/index.ts`, `src/i18n/resources.ts` |
| Unit tests | Implemented scaffolding: native boundary mocked, never touches a real DB | `jest.setup.ts`, `__tests__/`, `jest.config.js` |
| Native smoke | Minimal: one launch reaches readiness; no restart-persistence or locale proof | `.maestro/smoke.yaml`, README "Tests and their limits" |
| Inventory CRUD | Not started: no screens, no domain logic, no search | `App.tsx` (readiness only); `odd/tasks/mobile-foundation.md` |
| Releases | Source-only GitHub releases; no signing, EAS, or store upload | README "Quality and automation" |
| Review/tooling | Prior native review held per user instruction; work-unit commits pending authorization | `odd/tasks/mobile-foundation.md` |

Authoritative prior record: `odd/tasks/mobile-foundation.md`
(foundation scope, native runtime evidence, held review) and
`odd/tasks/product-roadmap-design.md` (this planning task).

## 2. Goals and non-goals

Goals (approved MVP "Inventory by location"):

1. Create, edit, and delete items carrying name, quantity,
   location, and optional category; search items with name search
   as the approved baseline (location/category matching proposed,
   see section 9).
2. Browse and search organized around location.
3. Fully offline, on-device, in English and Spanish.
4. Native-feeling Android and iOS UI from the start (see
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
  decision per gate before M1 writes any migration.
- Acceptance: every gate in section 9 has an explicit user decision
  (adopt, amend, or defer with a named owner); DESIGN.md wireframes
  reviewed with no open layout or state contradiction.
- UI-from-start rule: M1 field limits, backfill values, and index
  choices must match the reviewed wireframes; a schema change that
  alters the form or list returns to the wireframes first.

### M0 — Recorded baseline (completeness not verified; no work proposed)

Record only. Section 1 is the recorded baseline; its completeness is
not verified here. Nothing to build; future milestones must preserve
the mocked native test boundary and the versioned-migration
discipline.

### M1 — Data model and migration v2 (depends on M0)

Proposed surfaces: `src/db/migrations.ts` (new v2 migration),
domain types plus validation (new, e.g. `src/inventory/`), Jest
suites for migration and validation.

- Add columns/constraints for `quantity`, `location`, optional
  `category` to `items` (v1 rows carry only `id`/`name`/`created_at`;
  backfill required). Proposed limits, subject to approval: name
  required, trimmed, 1–120 characters; quantity integer 0–999999;
  location required, trimmed, 1–80 characters; category optional,
  trimmed, max 80 characters. Proposed backfill: `quantity = 1`,
  `location = 'Unassigned'` (stored key, translated for display),
  and a proposed index on `location` (plus `name` for search
  ordering).
- Accent handling (proposed, subject to approval): store user text
  verbatim; match accent-insensitively by folding both query and
  candidate (Unicode NFD, strip combining marks, lowercase) at
  query time, so `cafe` finds `café` in both languages.
- Acceptance: v1 database with pre-existing rows migrates to v2 with
  zero data loss; downgrade is out of scope and documented; every
  adopted limit and backfill value is recorded in the migration test.
- Test-first: RED with a migration test on a v1-shaped fixture, then
  GREEN with the migration; TRIANGULATE with empty DB, v1 rows, and
  already-v2 DB cases. Distinct from the fake-boundary Jest tests,
  the migration SQL also runs once against a real native SQLite v1
  fixture (isolated check, not the Jest suite) before M2.
- Risk: a `NOT NULL` column without a default makes the migration
  statement fail; the failure alone does not wipe existing data, but
  careless retries or table rebuilds can. See section 5.

### M2 — Local CRUD repository (depends on M1)

Proposed surfaces: repository module (create/read/update/delete with
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

Proposed surfaces: list screen, search field, empty/first-run states,
loading/error states. Design contract: [DESIGN.md](DESIGN.md)
sections 3–4 (list, search, states, tokens).

- List grouped or filterable by location; search matches name (and
  location/category per the adopted decision in section 9).
- Acceptance: empty DB teaches the user how to add the first item
  (not a bare "nothing here"); search is case- and
  accent-insensitive for `en`/`es`; loading shows skeletons, not a
  bare spinner; DB error shows retry.
- Test-first: RED with component tests for empty, populated, and
  error states; GREEN with the screen; TRIANGULATE no-match search
  and very long names.
- UX from the start: this is the first user-visible MVP surface, so
  [DESIGN.md](DESIGN.md) list/search wireframes govern layout.

### M4 — Add, edit, location input, delete (depends on M2, UX from M3)

Proposed surfaces: add/edit form screen (or sheet per OS convention),
location input, delete confirmation, validation messages. Design
contract: [DESIGN.md](DESIGN.md) sections 3–5.

- Fields: name, quantity stepper/input, location, optional category.
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
- Screen-reader pass on every screen and control; touch targets per
  OS minimum; reduced-motion honored.
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

- v1→v2 must backfill `quantity`/`location` for rows that predate
  those columns; a `NOT NULL` column without a default makes the
  migration statement fail (the failure alone does not wipe data).
  Mitigation: additive migration with explicit defaults, exercised
  by a v1-fixture Jest test plus one real native SQLite fixture
  check before any UI work.
- No downgrade path is proposed; document that a v2 database does
  not open cleanly on older code.
- The app provides no backup or sync of its own, so an in-app
  delete is irreversible; that says nothing about OS-level backup
  behavior, which is unknown and must not be promised. M4 requires
  confirmation and DESIGN.md specifies the wording.
- Never interpolate user input into SQL; use bound parameters in
  every new query (M2 acceptance).

## 6. Native test matrix (proposed, not yet run)

| Layer | What | Where |
| ----- | ---- | ----- |
| Unit | Migration, validation, repository logic on fakes | `__tests__/` via `npm run test:ci` |
| Type/lint/format | `tsc --noEmit`, Biome check and format | `npm run check` |
| Compat/export | `expo install --check`, unsigned Android export smoke | `npm run compat`, `npm run export:smoke` |
| Device smoke | Readiness plus (new) add/search/edit/delete flows | Maestro on debug build (`com.tengo.app`) |
| Native migration | v2 migration SQL on a real v1 SQLite fixture | Isolated native check (not Jest), before M2 |
| CRUD persistence | Create/edit/delete survive force-stop + relaunch | Debug build (`com.tengo.app`), recorded manually |
| Manual device | Restart persistence, `es` device locale, dark mode, large text, keyboard/safe-area on one Android phone and one iPhone | Emulator/simulator or hardware; record which produced the evidence |

No successful runs are claimed here; section 1 records what exists
today, sections 3–5 record what is proposed.

## 7. Cross-cutting requirements (MVP must meet all)

- Search: name matching is the approved baseline; location/category
  matching follows the adopted decision (section 9); case- and
  accent-insensitive in both languages; no-match state names the
  query and offers a clear path.
- Validation (proposed limits, subject to approval): name trimmed
  1–120 characters; quantity integer 0–999999; location trimmed
  1–80 characters, required; category trimmed, max 80, optional.
  Inline errors in the current language, next to the field.
- Errors: typed domain errors mapped to translated UI copy; DB
  failure shows retry, never raw SQLite text or a blank screen.
- Empty: first-run teaches adding the first item; location groups
  with zero items explain why rather than silently vanishing.
- Accessibility: screen-reader names on all controls; OS minimum
  touch targets; visible focus; errors announced; reduced-motion
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
choices first: TestFlight vs. App Store, Google Play internal track
vs. production, signing ownership, and whether review screenshots
come from emulator/simulator or hardware. None of these is decided.

## 9. Decision gates (must close before or during build)

| Gate | Closes in | Recommended default (approval still required) |
| ---- | --------- | ---------------------------------------------- |
| Wireframes + gate defaults reviewed | G0 (before M1) | Review DESIGN.md wireframes; adopt, amend, or defer each default with a named owner |
| Quantity semantics | M1 | Non-negative integer 0–999999, no units; zero allowed ("ran out, keep the row"); v1 backfill 1 |
| Locations | M1/M4 | Free text with recency suggestions, not a managed list |
| Categories | M1/M4 | Optional free text (suggested values only); search filters by it |
| Deletion/backup | M4 | Confirm every delete; no trash/undo in MVP; irreversible is stated in the dialog |

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

- [ ] G0: wireframes reviewed and every section 9 gate has a
  recorded user decision before any M1 schema work.
- [ ] M1: v1→v2 migrates fixture rows with zero loss on the fake
  boundary and in one real native SQLite fixture check; validation
  rules tested.
- [ ] M2: CRUD repository with parameterized SQL; error mapping
  tested; create/edit/delete survive force-stop + relaunch on a
  debug build.
- [ ] M3: list/search/empty/loading/error states per DESIGN.md.
- [ ] M4: add/edit/delete with validation and confirm; no silent
  data loss.
- [ ] M5: `en`/`es` audit, screen-reader pass, contrast floor and
  performance budgets observed on a device pass, extended Maestro
  flows observed on a debug build.
- [ ] All four open gates in section 9 recorded as user decisions.
- [ ] No backend/accounts/sync introduced; web still fails fast;
  releases still source-only.
