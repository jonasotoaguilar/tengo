# Tengo

Local-first household inventory for Android: one household, one on-device SQLite database, no backend, no accounts, no sync.

## What It Does

Tengo helps one household record what it owns, how much, and where
it is — organized by location, in English or Spanish. The app works
fully offline against on-device SQLite (`tengo.db`).

Current state is honest: the default app screen is the wired read-only
inventory list (search, location/category filters, loading/empty/no-results
with retry) backed by the on-device database. Add/Edit product UI is not
available until M4. M2 native persistence is verified on Android; M3
native UI proof, M4 forms, M5 hardening, and full Maestro E2E are still
pending.

## Quick Start

Prerequisites: Node `26.8.1` pinned via `.nvmrc` (`engines`
requires `node 26.x`, npm `>=11`). Native runs also need Java +
Android SDK (`adb`).

```sh
npm ci
npm start
```

`npm start` opens the Expo dev server. `npm run android` opens the
same server target on an emulator or device. `npm run web` fails
fast: native only. `npm run check` runs `typecheck` + `lint` +
`format:check`. Run scripts are declared in `package.json`
(`npm ci` is npm's own clean-install command); see
[docs/development.md](docs/development.md) for the full table.

## Core Workflow

1. Install and start the dev server (`npm ci`, `npm start`).
2. Open the app on Android and confirm the inventory list loads
   (count, rows, or the first-run empty state).
3. Browse, search, and filter items by location and category — adding
   and editing items lands with M4.

## Key Features You Should Know About

- Wired inventory list (the App default) with versioned SQLite bootstrap
  (schema v2: locations, categories, items with a required
  location reference and quantity, plus an item-category join).
- English/Spanish from day one with device-locale detection.
- Domain validation and parameterized location/category/item
  repositories with typed errors that never surface raw SQLite
  text.
- Bounded `queryItems` read-model filter and a read-only container with
  stale-safe filter/retry (host-verified only, no native UI proof yet).
- DEV-only native fixtures plus a single-session Maestro smoke
  flow; details and limits in [docs/testing.md](docs/testing.md).

## Documentation

| Your task | Start here |
| --- | --- |
| Product scope and constraints | [PRODUCT.md](PRODUCT.md) |
| Build order and milestones | [ROADMAP.md](ROADMAP.md) |
| Planned UX and states | [DESIGN.md](DESIGN.md) |
| Setup and quality commands | [docs/development.md](docs/development.md) |
| Test boundaries and native protocol | [docs/testing.md](docs/testing.md) |
| Wireframe boards and transitions | [design/wireframes/README.md](design/wireframes/README.md) |

## Next Steps

- Set up your environment in [docs/development.md](docs/development.md).
- Read the test limits and native protocol in [docs/testing.md](docs/testing.md) before claiming device evidence.
- Follow [ROADMAP.md](ROADMAP.md) for the M3 integration path.
