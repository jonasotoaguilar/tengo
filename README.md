# Tengo

Local-first household inventory for Android: one household, one on-device SQLite database, no backend, no accounts, no sync.

## What It Does

Tengo helps one household record what it owns, how much, and where
it is — organized by location, in English or Spanish. The app works
fully offline against on-device SQLite (`tengo.db`).

Current state is honest: the default app screen is the wired inventory
list (search over item, location and category names, location/category
filters, loading/empty/no-results with retry) backed by the on-device
database, with add, edit and delete wired through the same container
(`enableMutations`). M1–M5 are implemented; their native gates were
observed on Android on the previous model, and the four Maestro flows were
re-observed on the v4 model, where all of them pass and the search budget is
missed. The recorded boundaries live in
[docs/testing.md](docs/testing.md) — screen-reader speech is not claimed
and the device figures are single-sample.

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
3. Browse, search (by name, location or category) and filter by
   location and category; add, edit and delete items from the list.

## Key Features You Should Know About

- Wired inventory list (the App default) with versioned SQLite bootstrap
  (schema v6: items catalog plus stock(item_id, location_id, quantity)
  with a composite primary key, quantity > 0, both foreign keys
  ON DELETE CASCADE and idx_stock_location_id; an item-category join,
  unique indexes on the folded entity name, and a partial unique index
  on the normalized location address that leaves NULL addresses legal).
- English/Spanish from day one with device-locale detection.
- Domain validation and parameterized location/category/item
  repositories with typed errors that never surface raw SQLite
  text.
- Bounded `queryItems` read-model filter (three batched reads) and a
  container with stale-safe filter/retry, verified on Android.
- DEV-only native fixtures plus guarded Maestro flows (smoke,
  list/search, forms at 1.0x and 2.0x) run through
  `scripts/run-maestro.sh`, which keeps artifacts in `.maestro/runs/`;
  details and limits in [docs/testing.md](docs/testing.md).

## Documentation

| Your task | Start here |
| --- | --- |
| Product scope and constraints | [PRODUCT.md](PRODUCT.md) |
| Build order and milestones | [ROADMAP.md](ROADMAP.md) |
| Planned UX and states | [DESIGN.md](DESIGN.md) |
| Setup and quality commands | [docs/development.md](docs/development.md) |
| Test boundaries and native protocol | [docs/testing.md](docs/testing.md) |
| Wireframe boards and transitions | [design/wireframes/README.md](design/wireframes/README.md) |
| Distribution preparation (no store upload) | [docs/distribution.md](docs/distribution.md) |

## Distribution

Distribution preparation exists but no store pipeline: hand-written
`eas.json` (Android-only profiles, local versioning), release fields in
`app.json`, and the release process plus a listing-metadata draft in
[docs/distribution.md](docs/distribution.md). No EAS project is linked,
nothing has been built by EAS, nothing has been uploaded, and signing
is undecided. Releases stay source-only via `release.yml` on tag `v*`.

## Next Steps

- Set up your environment in [docs/development.md](docs/development.md).
- Read the test limits and native protocol in [docs/testing.md](docs/testing.md) before claiming device evidence.
- Follow [ROADMAP.md](ROADMAP.md) for the M3 integration path.
