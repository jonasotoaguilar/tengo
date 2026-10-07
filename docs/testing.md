# Testing — Tengo

Test boundaries and the native verification protocol. Setup and
quality commands live in [development.md](development.md).

## Unit-test boundary (Jest)

`npm test` runs against in-memory fakes with the native boundary
mocked (`jest.setup.ts`: `expo-sqlite`, `expo-localization`).
Suites cover migrations, DB init, M1 domain validation, M2
location/category/item repositories, the P3a `queryItems` filter,
the v2 schema contract, i18n (`en`/`es`), the App-wired P3b2
container, and the P3b1 controlled `InventoryList`.

Unit tests prove SQL structure, error mapping, and transaction
scoping only. They never touch a real database and are never cited
as native proof.

`python3 scripts/verify-inventory-schema.py` runs the real v2 SQL
against host SQLite (constraints, FK behavior, rollback
atomicity). That is host evidence only: it does not prove
`expo-sqlite`/device behavior.

## Verified native evidence (Android only)

- M1 migration: verified on Android, 5/5.
- M2 native persistence: verified on Android. Phase 1 passed 5/5,
  phase 2 passed 3/3, phase 3 passed 8/8, including scoped
  `PRAGMA foreign_keys = 1` verification, cascade cleanup,
  `RESTRICT` mapping, raw-FK mapping, invalid references,
  trigger-driven late-failure rollback with no orphans, and
  zero/many-category mapping.
- The fix under test: the shared managed factory
  (`src/db/exclusive.ts`) enables `PRAGMA foreign_keys = ON`,
  verifies it reads back `1`, and only then runs
  `BEGIN IMMEDIATE`.

P3a `queryItems` (108 tests), P3b1 controlled `InventoryList`
(130 tests, including 22 list tests), and the P3b2 App-wired
container (10 container plus 9 App suites) are reviewed host/fake
and host-SQL evidence only. There is no real Android UI, FAB, or
SQLite query proof for them yet.

## DEV-only native fixture protocol

Fixtures run the real `expo-sqlite` driver with the actual
`initializeDatabase()` against throwaway `m1-fixture-*.db` files.
The `App.tsx` gate needs `__DEV__` plus the public flags:

- M1 fixture: `EXPO_PUBLIC_NATIVE_FIXTURE=1`.
- Repository fixture: `EXPO_PUBLIC_NATIVE_FIXTURE=1` **and**
  `EXPO_PUBLIC_NATIVE_REPOSITORY=1`.

Any other combination keeps the default readiness screen, and
release builds stay inert. Launch on a separate Metro port so the
normal `tengo.db` session is untouched:

```sh
EXPO_PUBLIC_NATIVE_FIXTURE=1 EXPO_PUBLIC_NATIVE_REPOSITORY=1 npx expo start --port 8082
```

The repository fixture needs three launches with force-stop and
relaunch between phases (never a same-process close/open) against
an installed debug build of `com.tengo.app` (no custom scheme).
Only a final launch-3 `pass` counts as the milestone gate; any
failure keeps the fixture DB for inspection.

Production `tengo.db` is never opened by fixtures and stays
unchanged (hash `b2ac60317201426d6852a8b8c6232ea4fd2aaf8069c791f866467c187904ab97`);
the prior failed `m1-fixture-repository.db` stays on-device
untouched for inspection. Never uninstall, reset, or clear
production data for verification.

## Maestro boundary

The existing `.maestro/smoke.yaml` flow proves one launch reaches
the wired inventory list with its loaded count in that session. It
does not relaunch the app, so it does not prove restart
persistence, and it asserts the list/count testIDs, so it does not
prove locale detection.

Android list filters, forms, discard/delete dialogs, and restart
E2E flows are planned but not available; no further Maestro
commands are documented here until those flows exist. Maestro runs
against the installed debug build; responsive Android checks
(orientation, large font, keyboard, contrast, light/dark) need a
device pass with actual metrics, still pending.
