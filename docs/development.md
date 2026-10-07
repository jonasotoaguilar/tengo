# Development — Tengo

Developer setup, source map, and quality commands. Reader flow:
setup → change → verify. For test boundaries, native fixtures, and
the Maestro protocol, see [testing.md](testing.md).

## Setup

Prerequisites that actually block setup:

- Node `26.8.1` pinned via `.nvmrc` (`engines` requires `node 26.x`,
  npm `>=11`).
- Java + Android SDK (`adb`) for native runs. iOS is not a current
  delivery target, blocker, or pending task.

```sh
npm ci
npm start
npm run android
```

`npm start` opens the Expo dev server. `npm run android` targets an
emulator or device. `npm run web` fails fast by design (native only).

> Blocked lifecycle scripts: if `npm ci` fails with `EALLOWSCRIPTS`,
> respect the policy and run `npm ci --ignore-scripts`, then
> `npx lefthook install` to wire the pre-commit hook.

Note: `package.json` still declares an `npm run ios` script and
`app.json` still carries an iOS bundle identifier. Those are latent
config details, not an active platform deliverable: no iOS build,
check, or proof is part of the current plan.

## Source map

| Path | Contents |
| ---- | -------- |
| `App.tsx` | Inventory app shell + DEV fixture gates (default screen is the wired list via `InventoryContainer`) |
| `src/screens/InventoryContainer.tsx` | Read-only M3 container: owns the `tengo.db` bootstrap, bounded `queryItems` reads, stale-safe filter/retry (Add/Open disabled until P4) |
| `src/components/InventoryList.tsx` | Controlled presentational list (wired into the app via `InventoryContainer`) |
| `src/db/` | `expo-sqlite` init + versioned migrations (schema v2) + managed exclusive-connection factory (`exclusive.ts`), no ORM |
| `src/inventory/` | Domain types, validation/normalization, location/category/item repositories, bounded `queryItems` read-model filter |
| `src/i18n/` | i18next resources (`en`/`es`; `es` is typed as `typeof en`) |
| `src/dev/` | DEV-only native fixtures (never product UI; protocol in [testing.md](testing.md)) |
| `__tests__/` | Jest suites (`jest-expo` preset, see `jest.config.js`) |
| `.maestro/smoke.yaml` | Native single-launch smoke flow |
| `scripts/verify-inventory-schema.py` | Host SQLite check of the v2 SQL (host evidence only) |

## Quality commands

All commands below are declared in `package.json`:

| Command | Purpose |
| ------- | ------- |
| `npm test` / `npm run test:ci` | Jest unit tests / CI mode (`--ci --runInBand`) |
| `npm run typecheck` | Strict TypeScript (`tsc --noEmit`) |
| `npm run lint` / `npm run lint:fix` | Biome check / autofix |
| `npm run format:check` / `npm run format` | Biome format check / write |
| `npm run check` | `typecheck` + `lint` + `format:check` |
| `npm run compat` | `expo install --check` (SDK compatibility) |
| `npm run export:smoke` | Unsigned Android `expo export` smoke test |

Add Expo SDK modules with `npx expo install <pkg>` so versions
resolve against the pinned SDK. Pinned versions live in
`package-lock.json`.

Biome (see `biome.json`) owns lint and format. The pre-commit hook
runs `biome check` on staged files only and never rewrites them;
fix violations with `npm run lint:fix` and re-stage. CI remains
authoritative: install, `check`, `test:ci`, `compat`, and an
unsigned Android export smoke.
