# Tengo

Local-first household inventory app (Expo React Native + TypeScript).
No backend, no accounts, no sync: one household, one on-device SQLite database.

> Current scope is the foundation only: app shell, SQLite initialization
> with a versioned initial migration, English/Spanish i18n, and Jest
> unit-test scaffolding. Inventory screens and CRUD do not exist yet.

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
| `src/i18n/` | i18next resources (`en`/`es`; `es` is typed as `typeof en`) |
| `__tests__/` | Jest/RNTL suites (`jest-expo` preset, see `jest.config.js`) |
| `.maestro/smoke.yaml` | Native smoke flow (needs a debug build on device/emulator) |
| `lefthook.yml` | Pre-commit config; local overrides go in `lefthook-local.yml` |

## Tests and their limits

`npm test` covers migration logic, i18n behavior (en/es),
DB-initialization logic, and the readiness screen. Native modules
(`expo-sqlite`, `expo-localization`, safe-area insets) are mocked — see
`jest.setup.ts` for the boundary. Unit tests never touch a real database.

Real persistence across restarts and device-locale detection need a
native runtime and are unverified: the Maestro smoke flow proves only a
single-session launch — readiness screen visible and DB bootstrap
reporting `ready` in that session. It does not relaunch the app, so it
does not prove stored data survives a restart, and it asserts the raw
`initializing | ready | error` state text, so it does not prove locale
detection. Run `maestro test .maestro/smoke.yaml` against an installed
debug build of `com.tengo.app` for that single-session signal only.

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
