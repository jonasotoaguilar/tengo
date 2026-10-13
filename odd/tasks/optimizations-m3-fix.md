# m3-query flow fix: navigation guards for the nostock header and the post-filter search tap

Flow-only change on branch `feat/optimizations`, tip `f5979d5`. No `src/`
file touched; nothing committed or pushed. No assertion and no tap target
was weakened, changed, or removed — both fixes are navigation only, and
the flow still proves exactly what it proved before.

## Guard added (`.maestro/m3-query.yaml`)

Pattern followed: the Garage-header guard directly above it (flow lines
~111–128) — `scrollUntilVisible` on the header `DOWN` immediately before
the bare `assertVisible` on the same id, because below-the-fold group
headers are virtualized and "a bare assert fails nondeterministically".

```yaml
# Trailing sin-stock group: rows 2+5 under the translated group name.
# The nostock header sits below the fold under the Garage row; scroll it
# into view before asserting it (same virtualization as the Garage header).
- scrollUntilVisible:
    element:
      id: 'inventory-group-nostock'
    direction: DOWN
- assertVisible:
    id: 'inventory-group-nostock'
```

The three lines added are the `scrollUntilVisible` block plus its comment;
the `assertVisible inventory-group-nostock` and the `-name` / `-count`
asserts below it are byte-identical to before.

## Second guard: restore the search header after clearing filters

Pattern followed: the file's own header-restore precedent (`Restore the
header after inspecting the virtualized rows below the fold`, and `Row 4
sits below the fold, so restore the header before clearing`) —
`scrollUntilVisible` on `inventory-search` with direction `UP`
immediately before tapping it.

```yaml
- tapOn:
    id: 'inventory-filters-clear'
# Clearing the filters leaves the viewport scrolled down while the search
# header sits at the top; restore it before tapping search (same
# virtualization as the group headers above).
- scrollUntilVisible:
    element:
      id: 'inventory-search'
    direction: UP
# No-results names the miss and clears back to the full list.
- tapOn:
    id: 'inventory-search'
```

The `tapOn inventory-filters-clear` and `tapOn inventory-search` lines
are byte-identical to before; only the scroll block plus its comment
was inserted between them. `npm run verify:flows` passes on the
twice-edited flow (exit 0, see below).

## Round 1 re-observation (one guard: nostock scroll)

Metro served the QUERY bundle from `/home/sv-home/projects/tengo-worktrees/optimizations`
at `f5979d5` with `EXPO_PUBLIC_NATIVE_FIXTURE=1 EXPO_PUBLIC_NATIVE_QUERY=1`
on host port 8082 (no `MAESTRO_REVERSE`, per `docs/testing.md`). The tree
was dirty only outside `src/` (pre-existing `M odd/tasks/optimizations.md`
plus this flow edit); `git status --short -- src/` was empty, so the bundle
is the tip's own code. Device `emulator-5554`, wrapper
`scripts/run-maestro.sh`, pre-existing `adb reverse tcp:8082 tcp:8082`
left in place. `tengo.db` never created, opened, or modified; no `pm
clear`, no uninstall; only the isolated `m1-fixture-query-m3.db` files.

| run | pass/fail | steps | failing sequence if any | evidence path |
| --- | --- | --- | --- | --- |
| 1 | FAIL | 52 COMPLETED / 1 FAILED | seq 52: `^3 (of\|de) 5$` on `inventory-count` after typing `CAFÉ` | `.maestro/runs/20261012_232902_m3-query` — JUnit `tests=1 failures=1` |
| 2 | FAIL | 82 COMPLETED / 1 FAILED | seq 82: `tapOn inventory-search` after `tapOn inventory-filters-clear`, `Element not found` after ~17.4 s | `.maestro/runs/20261012_233122_m3-query` — JUnit `tests=1 failures=1` |
| 3 | FAIL | 82 COMPLETED / 1 FAILED | seq 82, same step and error as run 2 | `.maestro/runs/20261012_233439_m3-query` — JUnit `tests=1 failures=1` |

## Round 2 re-observation (both guards in place)

Same protocol as round 1, fresh Metro on the same checkout at `f5979d5`
(QUERY flags, host 8082, no `MAESTRO_REVERSE`; `git status --short --
src/` empty, so the bundle is again the tip's own code). Three runs,
no re-runs, nothing cherry-picked.

| run | pass/fail | steps | failing sequence if any | evidence path |
| --- | --- | --- | --- | --- |
| 4 | PASS | 110 COMPLETED / 0 FAILED | none | `.maestro/runs/20261012_234143_m3-query` — JUnit `tests=1 failures=0`, `status=SUCCESS`, ~2m47s |
| 5 | PASS | 110 COMPLETED / 0 FAILED | none | `.maestro/runs/20261012_234449_m3-query` — JUnit `tests=1 failures=0`, `status=SUCCESS`, ~2m45s |
| 6 | PASS | 110 COMPLETED / 0 FAILED | none | `.maestro/runs/20261012_234752_m3-query` — JUnit `tests=1 failures=0`, `status=SUCCESS`, ~2m51s |

`npm run verify:flows` exit code (re-run on the twice-edited flow): **0**
(`Maestro flow validation passed`, 6 flows).

## Verdict: the virtualization flake class is closed, with stated limits

- Three consecutive full passes (110/110 each, six for six counting no
  failures across the three runs), each observed and reported — no
  green run claimed without seeing it, no failing run discarded. The
  round-1 repeatable failure at seq 82 did not recur once the
  post-`filters-clear` scroll guard was added, and the original nostock
  assert site has now passed in all six runs on this tip (three round-1
  runs past it, three round-2 full passes through it).
- Every pass above is a sample of three on one emulator, not a rate
  proof. The `hideKeyboard` BACK flake seen in round-1 run 1 is a
  separate, still-open nondeterminism class in this flow (documented in
  `docs/testing.md`): three passes do not prove it gone, only that it
  did not fire in runs 4–6.
- Scroll-offset hypothesis (round-1 open question: whether the tip's
  list memoization preserves the viewport offset across the filter
  reset where the base re-render returned to the top): still open and
  deliberately unresolved. The guard makes the flow insensitive to
  wherever the viewport rests after `filters-clear`, so the runs cannot
  distinguish "offset now persists" from "offset still resets but the
  scroll is a harmless no-op". Resolving it would need product-side
  investigation (e.g. dumping scroll offset across the reset on both
  commits), which stays out of scope — the flow no longer depends on
  the answer.
- No second device, no percentiles; JUnit carries only step counts and
  pass/fail.

## What the round-1 runs showed (kept as observed history)

- The new guard works in all three runs. The guard window (scroll to
  `inventory-group-nostock` plus the header/name/count asserts) is
  COMPLETED in every run — including run 1, which failed much later, and
  runs 2–3, which failed ~50 steps later. The original flake site (the
  bare `inventory-group-nostock` assert from the A/B diagnosis) did not
  fail once.
- None of the three runs passed end to end, and no run was re-done to
  chase green. Each failure was diagnosed from its artifacts before the
  next run:
  - Run 1 is the documented `hideKeyboard` BACK flake class (already
    recorded in `docs/testing.md`): the failure screenshot is the Android
    launcher home screen and the hierarchy carries zero `com.tengo` /
    `inventory` nodes with 19 `launcher` references — the app was
    backgrounded when BACK was sent with no keyboard up, so the `CAFÉ`
    count assert polled 15.3 s against the launcher. Note the lowercase
    `café` count assert (flow seq ~40) had already PASSED in this run, so
    folding itself worked minutes earlier on the same list.
  - Runs 2–3 fail repeatably at a step the base-commit pass got through:
    after `tapOn inventory-filters-clear` the list is back to the full
    5-item general view but scrolled down (Küche rows → Garage → No stock
    visible, fixture self-check `11/11 checks passed`), while
    `inventory-search` / `inventory-count` are scrolled off-screen (zero
    nodes in the hierarchy). The flow's next command is a bare `tapOn
    inventory-search` with no scroll guard, and `tapOn` does not
    auto-scroll — the same virtualization class as the nostock issue, one
    screen later. The product list in both screenshots is healthy (every
    group, row, quantity, and count correct, including `No stock 2
    items`), so this reads as flow-side scroll state, not a product
    defect — reported, not fixed, because only the nostock guard is in
    this task's scope.

## What remains undetermined after round 1 (kept; see round-2 verdict for what changed)

- (Resolved by round 2 as a flow matter — kept for the record:) whether the
  post-`filters-clear` failure rate differs from base. The guard makes the
  flow insensitive to the viewport position there, so the memoization /
  scroll-offset mechanism question stays open by design; see the verdict.

## State left behind

- Emulator `emulator-5554` left running; the verification-owned Metro on
  8082 stopped; `adb reverse` left at the pre-existing `tcp:8082
  tcp:8082`.
- Only files written by this task: `.maestro/m3-query.yaml` (the guard
  above) and this report (the authorized surfaces). `src/` untouched.
