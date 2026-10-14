# Testing — Tengo

Test boundaries and the native verification protocol. Setup and
quality commands live in [development.md](development.md).

## Unit-test boundary (Jest)

`npm test` runs against in-memory fakes with the native boundary
mocked (`jest.setup.ts`: `expo-sqlite`, `expo-localization`).
Suites cover migrations, DB init, M1 domain validation, M2
location/category/item repositories, the P3a `queryItems` filter,
the v2 schema contract, i18n (`en`/`es`), the App-wired P3b2
container, the P3b1 controlled `InventoryList`, and the U6
versioned export/import round trip (`__tests__/transfer.test.ts`
plus the container entry-point suite: file bytes, typed refusals,
single-transaction atomicity, and the share/pick wiring, all against
in-memory fakes with the `expo-sharing`/`expo-document-picker`/
`expo-file-system` boundary injected). A staged import applies only after an
explicit confirmation dialog naming the replacement impact and its
irreversibility (same destructive-confirmation pattern as the delete
dialogs); cancelling the dialog applies nothing and stays silent.
Known limitations, stated not waived: the file carries names,
quantities, barcodes, thresholds and expiries but not `created_at` or
row ids — ids are database-local by design, so an imported database
assigns new ones and pre-import scheduled reminder keys are cancelled
and re-homed on confirm. A hand-edited blank or space-padded expiry is
normalized (blank to none, padding trimmed) rather than rejected.

Unit tests prove SQL structure, error mapping, and transaction
scoping only. They never touch a real database and are never cited
as native proof.

`python3 scripts/verify-inventory-schema.py` runs the real v2 SQL
against host SQLite (constraints, FK behavior, rollback
atomicity). That is host evidence only: it does not prove
`expo-sqlite`/device behavior.

## Verified native evidence (Android only)

**The inventory model changed, and the device evidence has been re-observed on it.**
The earlier records below were observed on the previous model — schema v3, one
location per item, quantity stored on the item — and are kept as records of what
was observed then, not as descriptions of the current model. Commit `a29ddf0`
replaced it with schema v4: `items` is a catalog and
`stock(item_id, location_id, quantity)` holds what is where, so one item can
have stock in several locations with its own quantity in each. The DEV fixtures
and the Maestro flows were both adapted, and all four flows were re-observed on
emulator-5554 against the new model: `.maestro/m3-query.yaml` 108 steps with
zero failures, `.maestro/m4-forms.yaml` 107, `.maestro/m4-forms-large-text.yaml`
85 at 2.0x, and `.maestro/p5b-measure.yaml` 12. The measurement pass is recorded
in full below and carries one honest miss: the search figure rose from 174.6 ms
to 292.6 ms against the 200 ms budget, recorded as FAIL rather than waived.
Host-side evidence for the new model is `scripts/verify-inventory-schema.py`
passing 36 checks against real host SQLite 3.46.1 (including the rebuild trap
and the location cascade) plus the Jest suites (31 suites / 463 tests).

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
the schema version as it stood then (v2; v3 added the unique indexes),
FK enforcement, Unicode case matching without accent
folding (the folding realignment below supersedes that part), literal
search, location AND category OR, deduplication,
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

After the adopted cross-entity matching change the flow was corrected and
re-observed on the same emulator through `scripts/run-maestro.sh`: exit 0,
78/78 commands COMPLETED, JUnit `tests=1 failures=0` (`status=SUCCESS`) in
2m 6s, artifact `.maestro/runs/20261012_052042_m3-query`. The retry
expectation is now the true one — `H` matches three rows — and the flow
scrolls down to the third row and back up to the search field before
clearing it, a step the first revision needed after a device run failed at
that tap.

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
font, keyboard, contrast, light/dark) and the performance budgets are
recorded below as their own observed passes; the only native behavior
still unproven is typing a new value into a non-empty numeric quantity
field, which the form flow edits with the stepper.

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

The DEV fixture screens intentionally use untranslated English strings:
they render only when `__DEV__` plus an `EXPO_PUBLIC_NATIVE_*` flag is set
and can never ship in a release build.

## Query fixture protocol (P3b3, DEV-only)

Folding realignment (adopted 2026-10-12): the search contract is case- and
accent-insensitive now, so the seed's fifth item is `Cafe Napkin` (it was
`Nail`) and the fixture asserts folding in both directions (`café` 3, `CAFÉ`
3, `cafe` 3) instead of `cafe` 0, keeping 9/9 checks. `.maestro/m3-query.yaml`
followed (the `café` count went 2 -> 3 and three comments stopped describing a
no-fold contract) and was re-observed on emulator-5554 through
`scripts/run-maestro.sh`: exit 0, 72 commands COMPLETED, 0 FAILED, JUnit
`tests=1 failures=0` in 117.6s, including the `^3 (of|de) 5$` café assertion.
The cross-entity change then required the retry probe's own correction and a
second green re-observation at 78/78 (recorded in the M3 section above).
An earlier attempt failed honestly with a native fixture NPE, which did not
reappear when the bundle was served from a tree whose `src/` had no
uncommitted changes (as that run reported): a device run served from a mid-flight worktree is an inconsistent
snapshot and proves nothing. Two stale pre-realignment DEV databases were
captured with their sizes and sha256 prefixes in that run's report and then
deleted after the fixture refused to overwrite a partial seed; the CRUD
fixture and production `tengo.db` were never created, opened or modified. That
evidence lives in the run's gitignored `.maestro/runs/` artifacts rather than
in committed files, so it is cited from the run report and cannot be
re-derived from the repository alone.

The query fixture embeds the real `InventoryContainer` with an injected
isolated bootstrap, so the list on screen is the actual read model — no
list fakes. Only `m1-fixture-query-m3.db` (seeded) and
`m1-fixture-query-m3-empty.db` (unseeded first-run) are ever opened;
anything else is refused before open. Seeding is idempotent via an
exact-dataset marker and fails closed on partial state without
overwriting; both files are retained on pass and fail for inspection.

Model change: the seeded dataset and its checks were adapted to schema v4, so
the fixture now seeds an item with stock in two locations (total 6) plus two
items with no stock anywhere, and the checks moved to 2/2 groups. Every count
quoted in the paragraphs immediately below describes the PREVIOUS dataset and is
kept as history. The flow itself was rewritten for v4 and re-observed on a
device: `.maestro/m3-query.yaml` now runs 108 commands with zero failures
against this fixture, and that pass is recorded at the end of this document.

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
regexes; the query checks assert accent folding in both directions
(`café`, `CAFÉ` and `cafe` all return 3 of 5). The retry probe searches
one character, `H`, so additional
keystrokes cannot consume the one-shot failure and recover before
the error assertion. Under the adopted cross-entity matching that letter
is a folded substring over item, location and category names, so it
matches three rows (`Café Grinder` and `CAFÉ filter` through
`Küche`/`Kitchen`, plus `Hammer`); the flow pins that as
`^3 (of|de) 5$`, asserts the two rows above the fold, scrolls down to the
third and scrolls back up to the search field before clearing it.

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

### P5b performance measurement pass (DEV-only, on demand)

The fixture screen carries a `Measure performance` control
(`crud-fixture-measure`) that runs one measurement pass against the
isolated fixture database and reports real wall-clock numbers with
PASS/FAIL against the ROADMAP section 7 budgets. The pass never runs
automatically on mount, enforces the fixture-name allowlist before any
driver or repository call, and never touches production `tengo.db`.
It reports four checks under stable labels:

- `seed 500 items (diagnostic setup, no budget)` — inserts 500 items
  with their locations through the real repository, one atomic exclusive
  transaction per insert. The seed is deliberately not wrapped in a batch
  transaction: the repository's exclusive transaction runs on its own
  native connection, so nesting it inside the driver's
  `withTransactionAsync` aborted the pass on device (`Could not create
  item: storage unavailable.`). Setup only; no budget.
- `first-viewport data readiness (budget 1000ms)` — the real
  `queryItems` call producing the first page for the 500-item database.
  Budget: under 1000 ms.
- `search per keystroke, data layer only (budget 200ms)` — a filtered
  `queryItems` call (`Perf p5b item 1`, matching a realistic subset).
  Budget: under 200 ms. This figure is the DATA-LAYER cost of one
  keystroke; the UI-per-keystroke figure adds render on top of it and
  is not separately instrumented.
- `single-row write (budget 100ms)` — one real item creation end to end
  through the repository. Budget: under 100 ms.

A missed budget is recorded as FAIL with its measured value and the
pass still completes the remaining checks; a missed budget is never
waived or rounded. Repeated passes are safe: every measurement row
carries the stable `Perf p5b ` name prefix with dedicated locations
and categories, and each pass deletes exactly those rows before
reseeding, so measurement data never duplicates and M4 flow data is
never touched. The screen also reports the wall time from mount to the
first list-viewport `onLayout` under `crud-fixture-first-layout` as a
diagnostic with the observed value; no budget applies to it.

Results render under `crud-fixture-measure-results` with per-check
`crud-fixture-measure-check-<index>` lines carrying the label, the
measured milliseconds, and PASS/FAIL, so a device verifier reads them
from the screen and from `adb`-visible text. No budget may be claimed
as met until its number has been observed on a device pass.

#### Recorded device pass (emulator-5554, AVD Tengo_API34, Android 14)

First real pass, run on the installed debug build with the guarded CRUD
bundle and the isolated `m1-fixture-crud-m4.db`, after the seed fix
described above. Observed values, verbatim from the screen:

- `first list layout: 87.2ms (diagnostic, no budget)`
- `seed 500 items (diagnostic setup, no budget): 24095.2ms setup: 500
  items with locations/categories, no budget asserted — PASS`
- `first-viewport data readiness (budget 1000ms): 202.3ms vs budget
  1000ms: PASS`
- `search per keystroke, data layer only (budget 200ms): 200.8ms vs
  budget 200ms: FAIL`
- `single-row write (budget 100ms): 31.3ms vs budget 100ms: PASS`

The search figure is a real miss of the proposed ROADMAP section 7
budget and is recorded as FAIL, not waived or rounded: 200.8 ms of
data-layer work against a 200 ms budget, so the UI-per-keystroke figure
that adds render on top cannot meet it either. The seed figure is
unbudgeted setup and is slow by construction — one exclusive
transaction per insert (500 of them) — not a product-path measurement.
These are single-sample numbers from one emulator; no repetition,
percentile or second device is claimed. `tengo.db` was never created,
opened or modified.

#### Recorded device pass after the P5g read-shape change

The search miss above came from reading the whole table and only then
filtering. `queryItems` now reads the item page without the location
join, then the category links only for the name survivors, then the
locations only for the survivors that also pass the category filter —
the predicates run before any `Location`/`ItemDetail` allocation. Same
emulator, same AVD, same isolated database, same query:

- `first list layout: 112.3ms (diagnostic, no budget)`
- `seed 500 items (diagnostic setup, no budget): 26611.8ms — PASS`
- `first-viewport data readiness (budget 1000ms): 193.3ms vs budget
  1000ms: PASS`
- `search per keystroke, data layer only (budget 200ms): 114.3ms vs
  budget 200ms: PASS`
- `single-row write (budget 100ms): 29.6ms vs budget 100ms: PASS`

The search figure fell from 200.8 ms to 114.3 ms, so the proposed budget
is met by measurement rather than by waiving it; the earlier FAIL stays
recorded above as the reason the read shape changed. These are again
single-sample numbers from one emulator — no percentile, repetition or
second device — and the search figure is still the data-layer cost
only, with UI render on top not separately instrumented. The seed figure
is unbudgeted setup and varies run to run.

#### Recorded device pass after the adopted cross-entity search change

Search now matches the item name, its location name or any of its
category names, so the name-only short circuit is gone: a selective
keystroke must read the page, the category links for the whole page and
the locations for the category survivors before the text predicate can
be decided. The read bound is still three batched reads, and the cost
rose accordingly. Same emulator, same AVD, same isolated database, same
query, driven by `.maestro/p5b-measure.yaml` through
`scripts/run-maestro.sh` (artifacts in `.maestro/runs/`):

- `first list layout: 129.1ms (diagnostic, no budget)`
- `seed 500 items (diagnostic setup, no budget): 24929.2ms — PASS`
- `first-viewport data readiness (budget 1000ms): 162.6ms vs budget
  1000ms: PASS`
- `search per keystroke, data layer only (budget 200ms): 174.6ms vs
  budget 200ms: PASS`
- `single-row write (budget 100ms): 32.7ms vs budget 100ms: PASS`

The search figure rose from 114.3 ms to 174.6 ms and still meets the
200 ms budget, which is the number the change was allowed to spend. The
headroom is thinner than it was, so any further per-keystroke work needs
its own measurement instead of an estimate. These are again
single-sample numbers from one emulator — no percentile, repetition or
second device — and the search figure is the data-layer cost only, with
UI render on top not separately instrumented. The seed figure is
unbudgeted setup and varies run to run.

#### Recorded device pass on the v4 catalog-and-stock model

The model change split identity from storage, so a search no longer reads
one row per item: it reads the item page, the category links for the page,
the locations for the category survivors, and then one `stock JOIN
locations` read for the page's breakdown. Same emulator, same AVD, same
isolated database, same query, driven by `.maestro/p5b-measure.yaml`
through `scripts/run-maestro.sh` (artifacts in `.maestro/runs/`):

- `first list layout: 100.1ms (diagnostic, no budget)`
- `seed 500 items (diagnostic setup, no budget): 23640.5ms — PASS`
- `first-viewport data readiness (budget 1000ms): 222.4ms vs budget
  1000ms: PASS`
- `search per keystroke, data layer only (budget 200ms): 292.6ms vs
  budget 200ms: FAIL`
- `single-row write (budget 100ms): 44.9ms vs budget 100ms: PASS`

The search figure is a real miss: it rose from 174.6 ms to 292.6 ms, so
the budget the previous change was allowed to spend is now exceeded by the
storage read this model needs. It is recorded as FAIL and left unwaived,
and like every figure above it is a single sample from one emulator. The
honest next step is a repeated measurement before the cost is attributed
to a specific read, and then either a proportional fix or a recorded
limitation — raising the budget is not on the table, because the number
comes from the product's own section 7 and a miss is evidence about the
model rather than about the budget. The seed figure is unbudgeted setup
and varies run to run. `tengo.db` was never created, opened or modified;
the run cleared one stale WIP-seeded fixture database and touched only
isolated fixture files.

A repeated measurement on the same protocol, same seed, same emulator and a
clean tree gave **263.3 ms, 234.2 ms and 242.1 ms** — every one a FAIL, each
with at least 34 ms of margin, and every one below the 292.6 ms single sample
above. The figure is therefore a stable miss with roughly ±15 ms of noise rather
than one unlucky run, and headroom to 200 ms does not appear in any sample.

The cost was then attributed rather than assumed. Reads 1 and 2 keep the shape
they had on the previous model (the item page, then the category links over the
page's ids). Only read 3 changed: the previous model read `locations` by the
distinct survivor location ids, which returns about five rows for this seed,
while v4 reads `stock JOIN locations` over every survivor item id, which returns
about five hundred rows and repeats the location payload per item. That is the
shape the model requires — the text predicate cannot be decided until the
location names are in hand, and a search with no category filter leaves every
item a survivor — so the bridge pays one five-hundred-row join where it paid a
five-row lookup, a delta of about +70 to +90 ms over the previous 174.6 ms.

No proportional fix exists inside the query. Narrowing read 3 needs the
location-name verdict that read 3 itself produces; a SQL `LIKE` prefilter would
miss the accent-folded matches the product pins (`cafe` must find `café`);
splitting the read breaks the asserted three-read bound and adds the bridge
round trip that dominates on a device; and trimming the join's column list drops
data the display path needs. Recovery therefore needs an index- or
migration-level change — a folded generated column with an index, or full-text
search — which is a product decision carrying its own migration, not a query
edit. Until that decision is taken the budget stays MISSED and recorded as such:
it was not waived, rounded, or moved.

That conclusion is now **measured rather than argued**. A later attempt split
read 3 into a light read of the distinct location ids and names plus a breakdown
join narrowed to the final matches — a four-read bound — which cut the payload
from about five hundred rows to about a hundred and moved the figure from a
233.7 ms mean to 184.5 ms. But the three runs were 186.8 PASS, 204.7 FAIL and
162.0 PASS, so the budget was not recovered stably and the change was reverted
rather than kept. The residual cost is the extra bridge round trip, and the
±20 ms run-to-run noise puts 200 ms out of reach along this route.

The schema-level options are therefore the only remaining route, and neither is
free. An index over a folded column cannot serve a substring match, so it does
not help this predicate at all. A full-text index would preserve the
authenticated semantics — a literal, accent-folded substring over item, location
and category names — only if the application stores the folded copies itself and
keeps them in sync with triggers, and it brings the trigram tokenizer's own
constraints with it: queries shorter than three characters need a fallback, and
tokenization is not the same predicate as `includes`. Both carry a migration and
a semantics risk, so the budget stays MISSED and recorded until that decision is
taken.

The figures above, and the three repeats that follow, are read from the device
screen during the pass, which is how every measurement figure in this document
was captured. They are **not** persisted as artifacts: the flow asserts the
visibility of `check-0..3` and never their values, `junit.xml` carries only step
counts, `commands.json` only completion, and the run log only RUNNING and
COMPLETED. A later reader can therefore re-derive the four step counts and the
zero-failure result from `.maestro/runs/`, and cannot re-derive the
milliseconds. That limitation applies to every recorded pass here, not only to
this one.

#### Recorded device pass after the dependency alignment

The Expo patch alignment in `7b88604` changed the JavaScript bundle, so the four
flows were re-observed on it rather than assumed to still hold. Same emulator,
same AVD, same isolated databases, same commands:

- `.maestro/m3-query.yaml` 108 commands, zero failures
- `.maestro/m4-forms.yaml` 107 commands, zero failures
- `.maestro/m4-forms-large-text.yaml` 85 commands, zero failures at 2.0x
- `.maestro/p5b-measure.yaml` 12 commands, zero failures

`m3-query` failed once before passing, and that failure was diagnosed rather
than retried blindly: the recorded hierarchy at the failing step shows the
launcher home screen with `NexusLauncher` in the foreground, which is the
`hideKeyboard` BACK flake already recorded above and not a product or flow
defect. One diagnosed re-run then completed 108 of 108.

The measurement on this bundle: layout 104.2 ms (no budget), seed 23256.3 ms
(unbudgeted setup), first-viewport 230.5 ms against 1000 ms PASS, single-row
write 39.8 ms against 100 ms PASS, and search **272.6 ms against 200 ms: FAIL**.
That is the fifth sample of the miss (292.6, 263.3, 234.2, 242.1, 272.6) and it
keeps the same verdict: the budget is missed by 34 to 93 ms depending on the run,
and recovering it needs the index- or migration-level decision described above,
not another query edit.

#### Recorded M5 manual-device passes (emulator-5554, dark / large text / keyboard / locale)

One combined session on the CRUD fixture bundle (the same
`InventoryContainer`/`ItemForm` components as production, isolated
`m1-fixture-crud-m4.db`; `tengo.db` never created). Each state was read
from screenshots viewed as images plus UI dumps, not inferred.

- Dark mode (`adb shell cmd uimode night yes`, cold relaunch): true
dark background with all production text legible; the selected filter
chip, the Add FAB, the transient notice and the exhausted highlight
all render and stay visible. The DEV fixture header keeps its
hardcoded light background — DEV-only surface, not production UI.
- Large text (`settings put system font_scale 1.5`, then `2.0`, cold
relaunch each): no overlap and no clipped content. The
location/category chip rows live in a horizontal `ScrollView`, so
off-screen chips are reached by swipe rather than truncated; group
header plus count fits; the Add FAB stays fully visible. In the form
at 2.0x the title plus Close fits, the Name/Quantity rows fit
(steppers side by side), the location chips wrap to full-width lines
and stay readable, and the form scrolls (Categories below the fold).
- Keyboard (`2.0x`, Name field tapped): Gboard opens with the focused
field visible and the form scrolls under it. Save renders fully
(168x103, centred, above the gesture bar) after hiding the keyboard
and one scroll; its reachability is independently proven by the M4
flow's Save taps at 1.0x.
- Safe area: the FAB and Save both render above the gesture handle in
the screenshots; nothing is hidden behind system UI.
- Locale, es: `settings put system system_locales` was proven
INEFFECTIVE on this emulator (`persist.sys.locale` stayed empty and
the app correctly stayed English), so that attempt is an invalid test,
not a product finding. With per-app locales
(`cmd locale set-app-locales com.tengo.app --locales es-ES`, cold
relaunch) the list renders fully Spanish ("Buscar por nombre",
"Ubicaciones", "Todas", "Categorías") with zero English strings:
detection proven. With `--locales fr-FR` it renders fully English with
zero Spanish: fallback proven. Locales cleared afterwards.
- m4-forms under dark + 2.0x: the flow reaches `item-form/save` and
then FAILS with "Element not found", because at 2.0x Save sits below
the fold and Maestro does not auto-scroll. The product Save is proven
reachable by scroll (screenshot above), so this is a flow limitation,
not a product regression; `m4-forms.yaml` is left untouched as the
1.0x regression proof. A large-text variant would need explicit scroll
steps before below-the-fold taps.

#### Recorded 2.0x large-text Maestro pass (closes the flow limitation above)

`.maestro/m4-forms-large-text.yaml` is a separate DEV-only flow for
`font_scale 2.0`, where `item-form/save` and the row detail lines sit
below the fold and Maestro does not auto-scroll. Every below-the-fold tap
is preceded by an explicit `scrollUntilVisible` on the same stable
testID; on an already-visible element that step is a no-op, so the flow
stays valid if layout shifts. It fail-closes on `crud-fixture-screen`, so
it can never pass against production, and it starts by tapping
`crud-fixture-reset` so item ids are deterministic. The 1.0x
`m4-forms.yaml` stays untouched as its own regression proof.

Observed on emulator-5554 (AVD `Tengo_API34`, Android 14, installed debug
build, guarded CRUD bundle on Metro 8083, isolated
`m1-fixture-crud-m4.db`; `tengo.db` never created, opened or modified):

| Run | Command | Result |
| --- | --- | --- |
| 1 | `maestro --udid emulator-5554 test .maestro/m4-forms-large-text.yaml` at `font_scale 2.0` | exit 1 — 60/61 commands COMPLETED, step-061 FAILED: `assertVisible inventory-row-1-location` in the edit-persistence section (the row detail sits below the fold at 2.0x) |
| 2 | same command after the flow-only fix | exit 0 — 78/78 commands COMPLETED, 0 failed, 8/8 `scrollUntilVisible` steps COMPLETED |

Run 1 also exposed a second flow-side defect: `eraseText` on a WRAPPED
two-line name is caret-dependent (the tap lands mid-word, so backspaces
delete only the text before the caret and the remainder survives —
observed `Large Text Tomato Editedmato`), the same class as the numeric
field limitation in the 1.0x flow. The fix keeps the item name short and
single-line at 2.0x (`LT Tomato`) while location/category names stay long
because they are display-only, and adds the missing scroll steps. No
product code changed and the flow was not weakened.

Covered at 2.0x: fixture reset, create with inline new location and
category, create persistence across restart, edit of name and quantity
(stepper), edit persistence across restart, delete confirmation naming
the item, empty-state return, and delete persistence. Device state was
restored afterwards (`font_scale 1.0` verified, night mode `no`, app
locales empty, app force-stopped, Metro 8083 stopped).

#### Recorded device accessibility tree (M5 screen-reader criterion)

Every surface was dumped with `adb shell uiautomator dump` on
emulator-5554 at 1.0x (density 420 → ÷2.625; 48dp = 126px), on the
list-empty, add-form, populated-list, edit-form, discard-dialog and
delete-dialog states. Every `Button` carries a `content-desc` label, every
`EditText` carries a hint plus its visible label, and both dialogs expose
title/message text with labeled buttons; `enabled` is `true` for every
enabled control and `false` for the disabled steppers on an empty add
form.

Production touch targets, all at or above 48dp in their smaller axis
(width × height in dp): search 379.4×48.0; chips All 49.9×48.0, location
92.2×48.0, category 95.6×48.0; row 379.4×115.8 with the accessible name
`C3Beans, Quantity 2, C3Pantry, C3Greens`; FAB 70.9×48.0; Close
67.4×48.0; name 379.4×48.0; quantity 267.4×48.0; steppers 48.0×48.0;
location/category chips ≥91.8×48.0; Save 379.4×48.0; Delete 379.4×48.0;
discard Cancel/Confirm and delete Cancel/Confirm 331.4×48.0. Static text
lines (counts, labels, row sub-lines) are shorter than 48dp but are not
touch targets. Only the DEV-only fixture buttons `crud-fixture-reset`
(112.8×44.2dp) and `crud-fixture-measure` (173.0×43.8dp) miss 48dp
height; that surface never ships. The delete dialog named the stored item
(`Delete "C3Beans"?`) even with a dirty `C3BeansX` draft in the field.

Boundary, stated rather than glossed: this is the on-device accessibility
tree (roles, labels, enabled state, bounds). It is NOT a TalkBack speech
pass — TalkBack speech was not verified, and no screen-reader utterance is
claimed. A 2.0x observation worth noting: a wrapped row name scrolls under
the floating Add button while scrolling mid-list, which is the intended
Material overlay behavior; the last row keeps the existing
`insets.bottom + 96` list bottom padding, so nothing is permanently
obscured.

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

Run artifacts: in this project's observed runs Maestro writes each run's
`commands.json`, `manifest.json`, screenshots and `maestro.log` into
`$HOME/.maestro/tests/<timestamp>/<flow>/`, outside the repository — that
path comes from the runs themselves, not from `maestro test --help`, which
documents `--test-output-dir` but states no default. The CLI default report
format is `NOOP`, so no JUnit file is emitted unless one is asked for.
`scripts/run-maestro.sh <flow.yaml>` keeps the artifacts inside the
repository: it passes `--test-output-dir` pointing at
`.maestro/runs/<timestamp>_<flow>/` (gitignored, evidence rather than source,
with the flow name sanitized so a space in a file name cannot reach the path)
and adds `--format JUNIT --output <run>/junit.xml`, then prints the artifact
directory and the report's `tests/failures/errors` counts. It refuses the
flags it pins (`--test-output-dir`, `--format`, `--output`, `--udid`) instead
of letting a caller silently split the artifacts, and outside a git
repository it refuses to guess the root unless `MAESTRO_RUN_DIR` is set.
Set `MAESTRO_REVERSE=1` only when the bundle is served on host 8083 (the
guarded CRUD bundle): the app's `debug_http_host` preference points at 8082, so
the script then applies `adb reverse tcp:8082 tcp:8083`, removes that reverse
again when it exits, and prints the command to re-add it when a `tcp:8082`
rule existed beforehand. It is the wrong flag for the QUERY bundle, which is
served on host 8082: it replaces the working `tcp:8082 tcp:8082` rule with one
pointing at an empty port, and the flow then fails at its fixture gate with no
bundle request reaching Metro. That was observed on device, and it is why
`m3-query.yaml` is run through the wrapper without the flag.
`MAESTRO_RUN_DIR` overrides the artifact root and `MAESTRO_SERIAL` the device
serial (default `emulator-5554`).
`__tests__/run-maestro-wrapper.test.js` drives the wrapper with a fake
`maestro` and a fake `adb` on PATH, so its fail-closed paths, flag refusal,
exit-code propagation, quoted flow paths and the reverse add/remove are
covered without a device.

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

## Recorded M5 contrast measurements (computed, not device-sampled)

The M5 contrast floor is approved in `DESIGN.md` section 5 and
`ROADMAP.md` section 7: text at least 4.5:1, interactive control
boundaries at least 3:1. The values below are computed from the palette
literals in the four production surfaces with the WCAG relative
luminance formula. They are arithmetic on the committed token values,
not a screenshot or device sample, and they do not measure focus
indicators (which are drawn by the platform).

Text pairs, both schemes — all meet 4.5:1:

| Pair | Light | Dark |
| --- | --- | --- |
| primary text on background | 17.16 | 16.58 |
| primary text on surface | 15.32 | 15.05 |
| secondary text on background | 6.50 | 8.58 |
| secondary text on surface | 5.80 | 7.79 |
| button label (`accentOn` on `accent`) | 6.39 | 7.39 |
| accent as text on background | 6.39 | 9.35 |
| error text on background | 6.54 | 11.03 |
| error text on surface | 5.84 | 10.02 |
| inverse notice (`noticeText` on `noticeBackground`) | 17.16 | 16.58 |

Control boundaries — RESOLVED by the decision approved on 2026-10-12.
One `border` token used to serve both roles and failed the 3:1 floor
(light 1.73 against the background and 1.54 against the surface; dark
1.60 and 1.45). `src/theme/tokens.ts` now carries the two roles
separately, and it is the single source for every production surface:

| Role | Light | Dark | Against background | Against surface |
| --- | --- | --- | --- | --- |
| `controlBorder` (interactive extent cue) | #8A8578 | #6E6E73 | 3.68 / 3.69 | 3.38 / 3.37 |
| `separator` (decorative) | #C9C5B8 | #38383A | 1.73 / 1.60 | 1.54 / 1.45 |

`controlBorder` draws the search field, the name/quantity/new-location/
new-category inputs, the quantity steppers, and the location and category
chips. `separator` keeps the lighter value for the item row separators
and the static draft-tag outline, where WCAG 1.4.11 does not apply. The
same two roles are the approved `DESIGN.md` section 5 table rows.

Guard: `__tests__/contrast-floor.test.tsx` renders `ItemForm` and
`InventoryList` in both schemes, reads the boundary color each control
actually paints, and asserts at least 3:1 against the scheme's background
and surface. The observed RED before the fix was 56 failing assertions
(28 per scheme) carrying exactly the ratios above; the fix produced GREEN.
A later token edit or a control that keeps the older role now fails the
guard instead of passing unnoticed. Focus indicators stay platform-drawn
and unmeasured.



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
(orientation, large font, keyboard, contrast, light/dark) still need a
device pass with actual observations and remain pending. The P5b
performance pass above has now been measured on device; its search
check missed its proposed budget and is recorded there as FAIL.
