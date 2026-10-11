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
emulator-5554 (AVD Tengo_API34) with Maestro 2.11.0: 72/72 commands, one success,
zero failures, 73.7 seconds. It covered grouped rows and counts,
exhausted labels, Android FAB visibility, Unicode/literal search,
overlapping category OR without duplicates, no-results/clear,
first-run empty, and injected generic read-error/retry recovery.
The final assertion found row 1 after clearing search; exact
post-retry and final-clear count text was not captured.

Independent host verification passed 164 tests and `npm run check`.
P3b2's reviewed container unit included 13 container and 9 App tests.
Native M3 evidence uses the real container and repositories on
fixture databases, not production `tengo.db`.

The M4 form flow (`.maestro/m4-forms.yaml`) passed on emulator-5554 (AVD Tengo_API34)
and CLI: 97/97 commands, JUnit failures=0, ~261s, first attempt. It
exercised the real add/edit form against the isolated CRUD fixture
(`m1-fixture-crud-m4.db`) and covered empty first-run, create with an
inline new location and category, create persistence across
force-stop/relaunch, edit of name and quantity, edit persistence across
restart, dirty-discard Cancel and Discard, delete Cancel and
confirmation, and delete persistence across restart. Production
`tengo.db` was never created, opened, or modified. Details and the
previously failed attempts are in the CRUD fixture section below.

Locale detection, accessibility, responsive layout (orientation, large
font, keyboard, contrast, light/dark) and the performance budgets remain
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
starts from the empty isolated database. After the tap it waits on the
first-run call to action rather than on the transient status text: a
`tapOn` waits for the app to settle (~3.7s measured here), which outlasts
the reset, so `running` is already gone by the time the next command
samples the screen. The empty call to action is rendered only when the
read model returns zero items, and a stale empty read can only coexist
with an already-empty database, so in both cases the first created row is
still row 1. It covers
empty first-run plus the add call to action, create with inline new
location/category, relaunch persistence of the create, edit, relaunch
persistence of the edit, dirty-discard (Cancel keeps the edit,
Discard keeps the stored values), delete (Cancel keeps the row, confirm
removes it back to empty), and relaunch persistence of the delete. It
uses stable testIDs with en/es count regexes and anchored
`Quantity|Cantidad <n>` quantity assertions. The name field is cleared
with `eraseText`, but the quantity edit uses the stepper: tapping a short
centred number places the caret inside it, so a backspace-based clear
erases nothing and the new digit lands before the old one.

Run the isolated Android form flow with the guarded CRUD bundle:

```sh
maestro --udid emulator-5554 test .maestro/m4-forms.yaml
```

`npm run verify:flows` (part of `npm run check`) statically validates every
flow under `.maestro/` before any device run: only command names registered
by the pinned Maestro CLI, never `clearText`, a `hideKeyboard` before the
next tap after every `inputText`, and no waits on a transient state that a
tap-settle window hides. It does not verify selectors against component
source.

### M4 form flow — observed Android result

The following was observed on the Android emulator (emulator-5554 (AVD Tengo_API34),
`com.tengo.app` debug 1.0.0) by an independent device verifier, not
inferred from source or unit tests:

- `maestro --udid emulator-5554 test .maestro/m4-forms.yaml`: **97/97
  commands COMPLETED, JUnit `failures=0`, status SUCCESS, ~261s, first
  attempt** (no rerun needed).
- Observed on device: empty first-run; create with an inline new location
  and a new inline category; create persistence across `stopApp`/
  `launchApp`; edit of name and quantity; edit persistence across
  restart; dirty-discard Cancel path; dirty-discard Discard path; delete
  Cancel path; delete confirmation naming the item; delete confirmation
  returning the empty state; delete persistence across restart.
- Database safety: only `m1-fixture-crud-m4.db` was used; `tengo.db` was
  never created, opened, or modified, and the query fixture files kept
  their sizes and timestamps.

Several earlier attempts failed before this result and are recorded here
so they are not repeated: an unregistered `clearText` command, a wait on
the transient `running` status, a keyboard covering a tap target after an
`inputText`, and a cursor-dependent clear of the numeric quantity field.
The first three are now prevented by `npm run verify:flows`; the fourth is
why the quantity edit uses the stepper. Not yet proven natively: typing a
new value into a non-empty numeric quantity field, and any locale other
than the one the device was set to.

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

Forms, discard/delete dialogs and restart E2E are covered by the M4 form
flow above, whose passing Android result is recorded in that section.
Maestro runs
against the installed debug build; responsive Android checks
(orientation, large font, keyboard, contrast, light/dark) and the
performance budgets still need a device pass with actual metrics, and
remain pending.
