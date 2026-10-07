# Tengo

Local-first household inventory app (Expo React Native + TypeScript).
No backend, no accounts, no sync: one household, one on-device SQLite database.

> Current scope is the foundation plus the M1 inventory model: app shell,
> SQLite initialization with versioned migrations (schema v2: locations,
> categories, items with a required location reference and quantity, plus
> an item-category join), English/Spanish i18n, Jest unit-test scaffolding,
> and pure domain types/validation (`src/inventory/`). Inventory screens,
> CRUD, search, and filters do not exist yet (M2/M3).

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
| `src/db/` | `expo-sqlite` init + versioned migrations, no ORM |
| `src/inventory/` | M1 domain types + validation/normalization only (no queries) |
| `scripts/verify-inventory-schema.py` | Host SQLite check of the real v2 SQL (not device proof) |
| `src/i18n/` | i18next resources (`en`/`es`; `es` is typed as `typeof en`) |
| `__tests__/` | Jest/RNTL suites (`jest-expo` preset, see `jest.config.js`) |
| `.maestro/smoke.yaml` | Native smoke flow (needs a debug build on device/emulator) |
| `lefthook.yml` | Pre-commit config; local overrides go in `lefthook-local.yml` |

## Tests and their limits

`npm test` covers migration logic (fresh DB, empty v1, populated-v1
safe-stop, already-v2, unknown-future, rollback, FK pragma order),
DB-initialization logic, M1 domain validation/normalization, the v2 schema
contract, i18n behavior (en/es), and the readiness screen. Native modules
(`expo-sqlite`, `expo-localization`, safe-area insets) are mocked — see
`jest.setup.ts` for the boundary. Unit tests never touch a real database.

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
