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

M3 query checks passed 9/9 on Android using the isolated fixture:
schema v2, FK enforcement, Unicode case matching without accent
folding, literal search, location AND category OR, deduplication,
and zero-quantity/category mapping. The Unicode query measured
3.8 ms in that diagnostic run; no performance budget was asserted.

The complete `.maestro/m3-query.yaml` flow subsequently passed on
Tengo_API34 with Maestro 2.11.0: 72/72 commands, one success,
zero failures, 73.7 seconds. It covered grouped rows and counts,
exhausted labels, Android FAB visibility, Unicode/literal search,
overlapping category OR without duplicates, no-results/clear,
first-run empty, and injected generic read-error/retry recovery.
The final assertion found row 1 after clearing search; exact
post-retry and final-clear count text was not captured.

Independent host verification passed 164 tests and `npm run check`.
P3b2's reviewed container unit included 13 container and 9 App tests.
Native M3 evidence uses the real container and repositories on
fixture databases, not production `tengo.db`. Forms, restart E2E,
locale detection, accessibility and performance budgets remain
separate pending checks.

## DEV-only native fixture protocol

Fixtures run the real `expo-sqlite` driver with the actual
`initializeDatabase()` against throwaway `m1-fixture-*.db` files.
The `App.tsx` gate needs `__DEV__` plus the public flags:

- M1 fixture: `EXPO_PUBLIC_NATIVE_FIXTURE=1`.
- Repository fixture: `EXPO_PUBLIC_NATIVE_FIXTURE=1` **and**
  `EXPO_PUBLIC_NATIVE_REPOSITORY=1`.
- Query fixture (P3b3): `EXPO_PUBLIC_NATIVE_FIXTURE=1` **and**
  `EXPO_PUBLIC_NATIVE_QUERY=1`. Takes precedence over the other two
  gates; any other combination keeps the default screen, and release
  builds stay inert.

Without an enabled fixture branch, the default screen is the wired
inventory list. Release builds ignore fixture flags. Launch on a separate Metro port so the
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

## Query fixture protocol (P3b3, DEV-only)

The query fixture embeds the real `InventoryContainer` with an injected
isolated bootstrap, so the list on screen is the actual read model — no
list fakes. Only `m1-fixture-query-m3.db` (seeded) and
`m1-fixture-query-m3-empty.db` (unseeded first-run) are ever opened;
anything else is refused before open. Seeding is idempotent via an
exact-dataset marker and fails closed on partial state without
overwriting; both files are retained on pass and fail for inspection.

Launch on a separate Metro port so the normal `tengo.db` session is
untouched:

```sh
EXPO_PUBLIC_NATIVE_FIXTURE=1 EXPO_PUBLIC_NATIVE_QUERY=1 npx expo start --port 8082
```

Fixture-only controls above the list: seeded/empty choice, a controlled
next-read failure (explicit fault injection, never real corruption)
proving generic error + retry, and a list reset that remounts onto the
same cached handle. Detailed checks live in a scrollable modal,
closed by default so diagnostics do not consume the list viewport.
The `.maestro/m3-query.yaml` flow fail-closes on
`query-fixture-screen` first. It uses stable testIDs and en/es count
regexes; query checks also verify `cafe` yields zero without accent
folding. The retry probe searches one character, `H`, so additional
keystrokes cannot consume the one-shot failure and recover before
the error assertion.

The independent Android flow passed as recorded above. It verifies
only this read-only list slice, not forms or restart persistence.
Production and the earlier failed repository fixture retained their
original hashes. Verification stopped the app and restored debug
preferences, the cached bundle and reverse-port configuration;
only the verification-owned Metro on 8082 was stopped.

## CRUD fixture protocol (M4, DEV-only)

The CRUD fixture embeds the real `InventoryContainer` with an injected
isolated bootstrap **and** `enableMutations`, so the add/edit/delete
form flows on screen run against the isolated database with real
persistence — no list or form fakes. Only `m1-fixture-crud-m4.db` is
ever opened or deleted; anything else, including production
`tengo.db`, is refused before open and before delete. The database
starts empty (the first-run screen owns the empty state) and persists
across relaunches so the flow can prove force-stop/relaunch
persistence for both creates and deletes.

Launch on a separate Metro port so the normal `tengo.db` session is
untouched:

```sh
EXPO_PUBLIC_NATIVE_FIXTURE=1 EXPO_PUBLIC_NATIVE_CRUD=1 npx expo start --port 8083
```

This gate takes precedence over the query, repository, and M1 fixture
gates; any other combination keeps its existing screen, and release
builds stay inert.

Fixture-only controls above the list: a compact header with the
readiness status plus a reset that closes, deletes, and reopens ONLY
the allowlisted fixture file, so the flow is repeatable without
touching any other file. The delete lives behind a module-level
invariant: the module tracks every handle it opened until its close
resolves (a rejected close keeps it tracked), and the reset refuses —
never deleting — while any handle is still tracked, no matter what the
caller believes. The screen closes every handle through the module,
keeps its reference until the close resolves, does not retry a rejected
close from the reset control, and surfaces `error` instead of deleting;
the unmount cleanup still makes one final best-effort close attempt.
The reset control is
disabled until the fixture reaches a terminal state (`ready`/`error`),
never mid-open. The `.maestro/m4-forms.yaml` flow fail-closes
on `crud-fixture-screen` first, then taps the reset control so every run
starts from the empty isolated database. After the tap it waits for
`crud-fixture-status` to pass through `running` and reach terminal
`ready` before asserting the empty state: the empty title alone could
already be visible from a previous empty run, so only the status cycle
proves the fresh generation is ready. It covers
empty first-run plus the add call to action, create with inline new
location/category, relaunch persistence of the create, edit, relaunch
persistence of the edit, dirty-discard (Cancel keeps the edit,
Discard keeps the stored values), delete (Cancel keeps the row, confirm
removes it back to empty), and relaunch persistence of the delete. It
uses stable testIDs with en/es count regexes and anchored
`Quantity|Cantidad <n>` quantity assertions.

The flow is authored here, not yet run: no native result is claimed
until a separate verifier runs it on a device/emulator build.

## Maestro boundary

The existing `.maestro/smoke.yaml` flow proves one launch reaches
the wired inventory list with its loaded count in that session. It
does not relaunch the app, so it does not prove restart
persistence, and it asserts the list/count testIDs, so it does not
prove locale detection.

Run the isolated Android list flow with the guarded query bundle:

```sh
maestro --udid emulator-5554 test .maestro/m3-query.yaml
```

Forms, discard/delete dialogs and restart E2E were pending until the
M4 form flow above was authored; that flow is still not yet run, so
until a separate verifier runs it on a device/emulator build those
areas remain unproven. Maestro runs
against the installed debug build; responsive Android checks
(orientation, large font, keyboard, contrast, light/dark) need a
device pass with actual metrics, still pending.
