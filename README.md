# Tengo

Local-first household inventory app (Expo React Native + TypeScript).
No backend, no accounts, no sync: one household, one on-device SQLite database.

> Current scope is the foundation plus the M1 inventory model and M2
> location/category/item persistence: app shell, SQLite initialization with
> versioned migrations (schema v2: locations, categories, items with a
> required location reference and quantity, plus an item-category join),
> English/Spanish i18n, Jest unit-test scaffolding, pure domain
> types/validation (`src/inventory/`), and parameterized location/category
> (`entityRepository`) and item (`itemRepository`) repositories over a minimal
> `RepositoryDb` of `runAsync`/`getFirstAsync`/`getAllAsync` plus the
> driver's exclusive-transaction hook, with typed
> `validation`/`not-found`/`in-use`/`storage` errors that never surface raw
> SQLite text. Item reads return the stored row with its resolved location
> entity and category list/ids; item mutations (including form drafts that
> create a new location and/or new categories with the item) run in one
> exclusive transaction on the scoped handle and fail closed without it, so
> failures leave no orphan rows. Deleting a location still referenced by
> items fails with `in-use`; deleting a category or item cascades only to
> join rows, never to items or entities. The P3a `queryItems` code unit
> (`src/inventory/itemQuery.ts`) filters the same read model with at most
> two batched reads (items+locations join, then one category-link join;
> empty results skip the second read): optional JS name substring
> (`toLowerCase` Unicode case, `cafe` never matches `café`, literal `%_\`)
> AND optional location AND any-category OR, stable `id ASC` order,
> valid-but-unknown ids yield `[]`, malformed filters reject before SQL,
> driver failures stay generic `storage/query`. Host-fake unit only — no
> UI wiring and no real-SQLite proof yet (P3b isolated fixture).

## Run it

Prerequisites: Node `26.8.1` pinned via `.nvmrc` (`engines` requires
`node 26.x`); `engines` requires npm `>=11` (observed `11.19.0`). Native runs
also need Java + Android SDK (`adb`) or Xcode.

```sh
npm ci
npm start
```

`npm start` opens the Expo dev server, which works in Expo Go: the
default `expo-sqlite` used here is Included in Expo Go per the official
SDK 57 docs (only opt-in SQLCipher-encrypted stores need a development
build, and this app does not use encryption). `npm run android` /
`npm run ios` open the same server target on an emulator or device.
The Maestro native smoke below is different: it drives an installed
debug build (`com.tengo.app`), not Expo Go. `npm run web` fails fast:
native only.

> Blocked lifecycle scripts: if `npm ci` fails with `EALLOWSCRIPTS`,
> respect the policy and run `npm ci --ignore-scripts`, then
> `npx lefthook install` to wire the pre-commit hook.

## Commands

| Command | Purpose |
| ------- | ------- |
| `npm test` / `npm run test:ci` | Jest unit tests / CI mode (`--ci --runInBand`) |
| `npm run typecheck` | Strict TypeScript (`tsc --noEmit`) |
| `npm run lint` / `lint:fix` | Biome check / autofix |
| `npm run format:check` / `format` | Biome format check / write |
| `npm run check` | `typecheck` + `lint` + `format:check` |
| `npm run compat` | `expo install --check` (SDK compatibility) |
| `npm run export:smoke` | Unsigned Android `expo export` smoke test |
| `npx lefthook install` | Install the pre-commit hook (also via `prepare`) |

Add Expo SDK modules with `npx expo install <pkg>` so versions resolve
against the pinned SDK. Pinned versions live in `package-lock.json`.

## Source map

| Path | Contents |
| ---- | -------- |
| `App.tsx` | Translated readiness screen + DB bootstrap (`readiness-*` testIDs) |
| `src/db/` | `expo-sqlite` init + versioned migrations + managed exclusive-connection factory (`exclusive.ts`), no ORM |
| `src/inventory/` | M1 domain types + validation/normalization and M2 location/category/item repositories (`RepositoryDb` with exclusive-transaction hook, typed errors, `entityRepository`, `itemRepository`) plus the P3a bounded `queryItems`/`ItemFilter` read-model filter (`itemQuery`, host-fake unit only) |
| `scripts/verify-inventory-schema.py` | Host SQLite check of the real v2 SQL (not device proof) |
| `src/i18n/` | i18next resources (`en`/`es`; `es` is typed as `typeof en`) |
| `__tests__/` | Jest/RNTL suites (`jest-expo` preset, see `jest.config.js`) |
| `.maestro/smoke.yaml` | Native smoke flow (needs a debug build on device/emulator) |
| `lefthook.yml` | Pre-commit config; local overrides go in `lefthook-local.yml` |

## Tests and their limits

`npm test` covers migration logic (fresh DB, empty v1, populated-v1
safe-stop, already-v2, unknown-future, rollback, FK pragma order),
DB-initialization logic, M1 domain validation/normalization, the M2
location/category/item repositories (parameterized CRUD, normalization,
unicode, injection-shaped inputs, invalid ids, missing rows, FK-to-`in-use`
mapping across native error shapes, generic storage failures, item read
model with location + categories, atomic category-set replacement,
form drafts with atomic new location/category creation and rollback
without orphans, fail-closed mutations when the exclusive-transaction
hook is absent, scoped-handle transaction evidence), the P3a bounded
item query (`queryItems`/`normalizeItemFilter`: Unicode-lowercase
substring, location-AND-category-OR, 2-read bound, validation-before-SQL,
generic storage errors; structural fake-SQL assertions only), the v2 schema
contract, i18n behavior (en/es), and the readiness screen. Native modules
(`expo-sqlite`, `expo-localization`, safe-area insets) are mocked — see
`jest.setup.ts` for the boundary. Unit tests never touch a real database:
the repository suites run against in-memory fakes (`RepositoryDb` with
snapshot/rollback transactions), so they prove SQL structure, error
mapping, and transaction scoping only — not real `expo-sqlite` behavior,
constraint enforcement, or persistence across restarts. That native proof
is P2b work on isolated test DBs (no production-data clear/reset/uninstall,
force-stop/relaunch gate before M3).

`python3 scripts/verify-inventory-schema.py` additionally runs the real v2
migration SQL against host SQLite (36 checks: constraints including integer
quantity storage, FK behavior, rollback atomicity). That is host evidence only: it does not prove
`expo-sqlite`/device behavior. The native gate — v2 migration plus
constraint behavior on a real emulator/device build — is still pending and
required before M2. Quantity is guarded by integer storage
(`typeof(quantity) = 'integer'`, rejecting fractions such as 1.5 in SQLite
itself) plus a technical safe-integer bound
(`Number.MAX_SAFE_INTEGER`, mirrored in SQL), not a product limit; no
product numeric caps, uniqueness rules, managed-location/category UI, or
accent folding are implemented.

Real persistence across restarts and device-locale detection need a
native runtime and are unverified: the Maestro smoke flow proves only a
single-session launch — readiness screen visible and DB bootstrap
reporting `ready` in that session. It does not relaunch the app, so it
does not prove stored data survives a restart, and it asserts the raw
`initializing | ready | error` state text, so it does not prove locale
detection. Run `maestro test .maestro/smoke.yaml` against an installed
debug build of `com.tengo.app` for that single-session signal only.

### DEV-only native SQLite fixture (T3 verification infra, no product UI)

`src/dev/nativeSqliteFixture.ts` + `src/dev/NativeSqliteFixtureScreen.tsx`
run the REAL `expo-sqlite` driver with the ACTUAL `initializeDatabase()`
against throwaway `m1-fixture-*.db` files (fresh/empty-v1 migrate, FK ON,
zero-qty + joins, null/absent-location and fractional-qty rejection,
populated-v1 safe stop, forced-transaction rollback). The `App.tsx` gate
needs BOTH `__DEV__` and `EXPO_PUBLIC_NATIVE_FIXTURE=1`, bypasses the
normal readiness screen entirely (never opens `tengo.db`), and is inert in
release. Unit tests mock this boundary; `scripts/verify-inventory-schema.py`
is host evidence only. Neither is native proof.

Launch on a second Metro port so the normal `tengo.db` session is untouched:

```sh
EXPO_PUBLIC_NATIVE_FIXTURE=1 npx expo start --port 8082
```

then open the dev build on the emulator and read the pass indicator:
`fixture-status` shows `running` → `pass`/`fail`, `fixture-summary` shows
`passed/total`, each case renders as `fixture-check-N`, failures also set
`fixture-error`. Observe via Maestro/`adb` (e.g. assert `fixture-status`
reads `pass`); do not cite Jest or the host script as device evidence.
No iOS proof exists (no Xcode in this environment).

### DEV-only native repository fixture (P2b verification infra, M2 gate)

`src/dev/nativeRepositoryFixture.ts` +
`src/dev/NativeRepositoryFixtureScreen.tsx` run the REAL `expo-sqlite`
driver with the ACTUAL `initializeDatabase()` (now via the shared managed
factory in `src/db/exclusive.ts`) and the ACTUAL M2
entity/item repositories against one throwaway `m1-fixture-repository-fk.db`
(validated before open AND delete; `tengo.db` is always refused; the prior
failed `m1-fixture-repository.db` stays on-device untouched for inspection). The
`App.tsx` gate needs `__DEV__` AND **both** public flags
(`EXPO_PUBLIC_NATIVE_FIXTURE=1` plus `EXPO_PUBLIC_NATIVE_REPOSITORY=1`);
any other combination keeps the M1 fixture mode/default above unchanged,
and release builds stay inert.

Three launches on a separate Metro port so the normal `tengo.db` session
is untouched — force-stop + relaunch between phases (never a same-process
close/open):

```sh
EXPO_PUBLIC_NATIVE_FIXTURE=1 EXPO_PUBLIC_NATIVE_REPOSITORY=1 npx expo start --port 8082
```

- Launch 1 creates locations/categories/items via the real repos, stores
  ids + marker, closes WITHOUT deleting → `repository-status` reads
  `restart-required` (`repository-phase` reads `phase-1`).
- Launch 2 verifies the rows persisted, updates one item, deletes another,
  closes WITHOUT deleting → `restart-required` (`phase-2`).
- Launch 3 verifies the edit/deletion + join cleanup persisted, typed
  `RESTRICT`, invalid-reference and trigger-driven late-failure rollback
  (no orphans; the temporary trigger lives only on the fixture DB and is
  dropped in a `finally`), zero/many-category + native-query mapping, and
  the scoped exclusive-connection FK state. Full pass closes + deletes
  ONLY the fixture file → `repository-status` reads `pass` (`phase-3`);
  any failure keeps the DB for inspection and reads `fail`.

Read `repository-phase`, `repository-status`, `repository-summary`
(`passed/total`), each `repository-check-N`, and `repository-error` via
Maestro/`adb`. ONLY a final launch-3 `pass` counts as the native
milestone gate. Actual on-device execution is PENDING (no device
operations run from here): no native pass is claimed until the verifier
reports the three observed statuses. Observed device bug: phase 3 failed
with the deleted item absent and an orphan `item_categories` row retained —
the driver's `withExclusiveTransactionAsync` ran item mutations on a NEW
connection (`Transaction.createAsync`,
`node_modules/expo-sqlite/build/SQLiteDatabase.js:561-567`) with no FK
pragma in that path, so scoped transactions ran FK-OFF. The bounded fix is
the shared managed factory (`src/db/exclusive.ts`, also used for the
default `tengo.db` open): each isolated exclusive connection enables
`PRAGMA foreign_keys = ON`, verifies `=== 1`, and only then runs
`BEGIN IMMEDIATE`; the probe still asserts join cleanup (`orphans === 0`),
scoped `PRAGMA foreign_keys === 1` plus bogus-join rejection, and the raw
mapping. Run the three launches fresh against `m1-fixture-repository-fk.db`
(force-stop + relaunch between phases, never a same-process close/open);
no native pass is claimed until the verifier reports all three observed
statuses, and M2 stays open.

## Maestro

- CLI: `~/.maestro/bin/maestro` is already on PATH in new shells (see
  `~/.bashrc`/`~/.zshrc`); in the current shell run
  `export PATH="$HOME/.maestro/bin:$PATH"` if `command -v maestro`
  finds nothing. Run the native smoke with
  `maestro test .maestro/smoke.yaml` against an installed debug build
  (`com.tengo.app`).
- Pi MCP: `.pi/mcp.json` defines project server `maestro`
  (`maestro mcp --no-viewer` over STDIO, `codemode` exposure); after
  changing it run `/mcp` then `/reload` and verify with `pi mcp list`.
- Studio: run `maestro-studio`, then New workspace on this checkout's
  `.maestro/` directory.

## Quality and automation

- Biome (see `biome.json`) owns lint and format. The pre-commit hook
  runs `biome check` on staged files only and never rewrites them, so
  partially staged files are always preserved; fix violations with
  `npm run lint:fix` and re-stage. CI remains authoritative.
- `actionlint` must pass on every workflow change.
- Push/PR runs `ci.yml`: install, `check`, `test:ci`, `compat`, and an
  unsigned Android export smoke (artifact kept 7 days).
- `pr-check.yml` validates PR metadata only (800-line authored review
  budget, excluding `package-lock.json` and vendored
  `.agents/skills/**` which are reported separately, with a
  `size:exception` escape; issue linkage and `type:*` labels are
  advisory). It never rebuilds or retests.
- `android-e2e.yml` (manual dispatch) prebuilds and `assembleDebug`s an
  unsigned APK on a fixed API 34 emulator, then runs the Maestro flow
  with a pinned, checksum-verified CLI. No signing, no EAS.
- `release.yml` (tag push `v*` or manual dispatch of an existing tag)
  creates a GitHub **source-only** release: a `git archive` tarball of
  the exact tag revision plus the unsigned export bundle. The tag must
  equal `v<package.json version>` or the job fails. Not store
  distribution: no signing, no EAS, no store upload.

## Agent skills

Four official [Expo skills](https://github.com/expo/skills) are vendored
read-only under `.agents/skills/`; each `SKILL.md` is the source of
truth and `skills-lock.json` pins the content hashes.

| Skill | Use for this stack |
| ----- | ------------------ |
| `expo-dev-client` | Dev builds for native runs |
| `expo-upgrade` | SDK upgrade discipline (pins Expo 57.0.26) |
| `eas-app-stores` | Future store releases only; releases stay source-only |
| `expo-native-ui` | Native-feeling screens (includes a SQLite reference) |

Reinstall exactly (project scope, no globals):

```sh
npx skills add expo/skills \
  --skill expo-dev-client expo-upgrade eas-app-stores expo-native-ui \
  --agent universal -y
```
