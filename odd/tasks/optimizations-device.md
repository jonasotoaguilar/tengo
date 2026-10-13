# Device re-observation on feat/optimizations @ f5979d5

State observed: branch `feat/optimizations`, tip `f5979d5` (six optimization
commits `2bbfbf7..f5979d5`), working tree clean except the pre-existing
`M odd/tasks/optimizations.md` and the untracked `node_modules` symlink
(neither touched by this pass). No `src/` file was modified, nothing was
committed or pushed.

Recipe verified before relying on it (against `docs/testing.md`,
`scripts/run-maestro.sh`, `scripts/boot-emulator.sh`): emulator AVD
`Tengo_API34` (`emulator-5554`, already running when this pass started),
`adb` at `$HOME/Android/Sdk/platform-tools` (not on `PATH`; used by full
path), Maestro 2.11.0, `JAVA_HOME` default from the wrapper
(`$HOME/.local/jdk-17.0.20.1+1`), QUERY bundle on host 8082 with **no**
`MAESTRO_REVERSE` (pre-existing `tcp:8082 tcp:8082` rule), CRUD bundle on
host 8083 with `MAESTRO_REVERSE=1`, artifacts under gitignored
`.maestro/runs/`. Both bundles were served from this tree with no
uncommitted `src/` changes.

## Flow results

| flow | pass/fail | steps | evidence path (JUnit) |
| --- | --- | --- | --- |
| m3-query (QUERY bundle, no reverse) | FAIL | run1: 3 COMPLETED / 1 FAILED; run2: 29 / 1; run3: 29 / 1 | `.maestro/runs/20261012_225537_m3-query`, `.../20261012_225634_m3-query`, `.../20261012_225923_m3-query` — JUnit `tests=1 failures=1` on all three |
| m4-forms (CRUD, `MAESTRO_REVERSE=1`) | PASS | 107 COMPLETED / 0 FAILED | `.maestro/runs/20261012_230141_m4-forms` — JUnit `tests=1 failures=0`, `status=SUCCESS` |
| m4-forms-large-text (CRUD, reverse, `font_scale 2.0`) | PASS | 85 COMPLETED / 0 FAILED | `.maestro/runs/20261012_230857_m4-forms-large-text` — JUnit `tests=1 failures=0`, `status=SUCCESS` |
| m6-entities (CRUD, reverse) | PASS | 124 COMPLETED / 0 FAILED | `.maestro/runs/20261012_230546_m6-entities` — JUnit `tests=1 failures=0`, `status=SUCCESS` |
| p5b-measure ×3 (CRUD, reverse) | PASS (flow) ×3 | 12 COMPLETED / 0 FAILED each | `.maestro/runs/20261012_231159_p5b-measure`, `.../20261012_231301_p5b-measure`, `.../20261012_231404_p5b-measure` — JUnit `tests=1 failures=0`, `status=SUCCESS` each |

m3-query failure diagnosis (from artifacts, not blind):
- Run 1 failed the gate (`query-fixture-screen`, 21 s). The failure
  screenshot shows the app on `Bundling 99%...` and the Metro log shows the
  cold QUERY bundle (`Android Bundled 15987ms index.ts, 808 modules`)
  finishing inside the assertion window — a cold-bundle timing flake, not a
  product or flow defect. Re-ran once on the now-warm bundle.
- Runs 2 and 3 both pass the gate and 29 steps, then fail the **same bare**
  `assertVisible inventory-group-nostock` after `group-2-count` passes
  (assertion polls ~18 s, then FAILs). The flow's own comment above that
  step documents this exact class: below-the-fold group headers are
  virtualized and a bare assert fails nondeterministically (it prescribes a
  `scrollUntilVisible` for the Garage header; the nostock assert has none).
- Product defect excluded by direct probe: after run 2, an `adb` swipe-down
  plus `uiautomator` dump (scratch copy under
  `~/.cache/tengo-scratch/optimizations-device/w-m3b.xml`) shows
  `inventory-group-nostock` + name + count mounted with both exhausted rows
  (`CAFÉ filter` Q0, `Cafe Napkin` Q0); the fixture self-checks read
  `11/11 checks passed` on screen. The product renders the group — the flow
  never scrolls it into view.
- Two consecutive same-step failures after passes on the parent state is
  noted honestly: it may be a high-rate flake of the documented class, or an
  interaction with the memoized list from `f5979d5` (rows/group headers are
  now `memo`, entries `useMemo`). Those two cannot be distinguished from
  these runs, and no further re-runs were spent — a third attempt would be a
  blind retry. The fix (a `scrollUntilVisible` guard for the nostock header)
  is a flow edit outside this task's surface; flagged for review, not applied.

## p5b search measurement (the re-observation this pass exists for)

Read verbatim from the on-device hierarchy (`crud-fixture-measure-check-*`)
after each pass; the flow asserts visibility only, so milliseconds live in
these notes, not in the artifacts.

- Pass 1: layout `129.1ms` (no budget) · seed `22491.7ms` (unbudgeted setup)
  · first-viewport `226.0ms` vs 1000ms PASS · **search `248.6ms` vs 200ms
  FAIL** · write `34.1ms` vs 100ms PASS.
- Pass 2: layout `111.3ms` · seed `22449.9ms` · viewport `247.4ms` PASS ·
  **search `213.8ms` FAIL** · write `30.5ms` PASS.
- Pass 3: layout `106.0ms` · seed `22374.1ms` · viewport `239.3ms` PASS ·
  **search `238.6ms` FAIL** · write `30.4ms` PASS.

Budget verdict: the 200 ms search budget is **MISSED on the current
committed state** — 3/3 samples FAIL with margins of 48.6, 13.8 and
38.6 ms. The figure moved down from the pre-change samples (292.6, 263.3,
234.2, 242.1, 272.6 — the debounce/static-cache/chunking work helped), but
no sample reaches the budget, and the closest (213.8 ms) still misses by
13.8 ms of data-layer cost with UI render on top uninstrumented. Recorded as
FAIL, not waived. These are **repeated numbers (n=3)**, same emulator, same
protocol, same seeded fixture; no percentile or second device is claimed.

## State left behind

- Emulator `emulator-5554` left **running** (it was running before this
  pass; boot takes ~1–2 min).
- Both verification-owned Metros (8082 QUERY, 8083 CRUD) **stopped**
  (verified: no `expo start` processes remain).
- `adb reverse` restored to the pre-existing `tcp:8082 tcp:8082` (the CRUD
  `tcp:8082 tcp:8083` rule was removed by the wrapper on exit; re-added the
  QUERY rule explicitly and listed it to confirm).
- App force-stopped; `font_scale` verified back at `1.0` (set to `2.0` only
  for the large-text flow); night mode and app locales never changed.
- Production `tengo.db` never created, opened, or modified; no `pm clear`,
  no uninstall; only isolated `m1-fixture-*.db` files were used (CRUD reset
  control deletes only the allowlisted fixture file).
- No commits, no pushes, no `src/` modifications.

## What could not be observed

- Every m3-query step after the nostock-header assert (Unicode/literal
  search, retry probe, clear, first-run empty) is **unobserved** on this
  state — the flow never got there. The m3 slice has no green pass on
  `f5979d5`.
- Millisecond figures for any flow other than p5b: flows persist step counts
  and pass/fail in JUnit, not values — no number is reported that was not
  read from the device screen/hierarchy.
- Flow pass/fail verdicts are single-run each (m4-forms, m4-forms-large-text,
  m6-entities ×1; p5b flow ×3 but its numbers are the repeated evidence).
  No second device, no percentiles.
