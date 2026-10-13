# m3-query A/B: base commit vs optimization branch

Diagnosis task only: observe and report. No `src/` file and no flow file was
modified in either worktree; nothing was committed, pushed, or deleted.

Recipe source: `docs/testing.md` (QUERY bundle on host 8082, **no**
`MAESTRO_REVERSE`), `scripts/run-maestro.sh`, and the prior device report
`odd/tasks/optimizations-device.md` in this worktree (branch
`feat/optimizations`, tip `f5979d5`). Emulator `emulator-5554` (AVD
Tengo_API34) was already running and was reused. Flow files verified
identical in both checkouts (`diff` of `.maestro/m3-query.yaml` empty).

Scratch worktree: `git worktree add --detach
/home/sv-home/projects/tengo-worktrees/m3-ab 9e23749`, with `node_modules`
symlinked from `/home/sv-home/projects/tengo/node_modules` (untracked
symlink only; `git status` otherwise clean). Every bundle was served from
the checkout matching the commit under test, from a clean tree.

## Runs performed by this task (both on the base commit, QUERY bundle from m3-ab)

| commit | flow | pass/fail | steps | evidence path | leftover state |
| --- | --- | --- | --- | --- | --- |
| `9e23749` (base) | m3-query | FAIL | 29 COMPLETED / 1 FAILED | `/home/sv-home/projects/tengo-worktrees/m3-ab/.maestro/runs/20261012_231827_m3-query` — JUnit `tests=1 failures=1`; failing assert `id: inventory-group-nostock is visible` after ~17.4 s poll | First run after Metro start; bundle served from m3-ab |
| `9e23749` (base) | m3-query | PASS | 108 COMPLETED / 0 FAILED | `/home/sv-home/projects/tengo-worktrees/m3-ab/.maestro/runs/20261012_232030_m3-query` — JUnit `tests=1 failures=0`, `status=SUCCESS` | Re-run on the now-warm bundle, same checkout, no other change |

Prior-branch runs cited (not performed here, from
`odd/tasks/optimizations-device.md`): on `f5979d5`, m3-query failed run 1 at
the `query-fixture-screen` gate on a cold bundle (timing flake), then failed
runs 2 and 3 at the same bare `assertVisible inventory-group-nostock` after
`group-2-count` passed (29 COMPLETED / 1 FAILED each).

## Verdict: the failure predates the optimizations

The base-commit run 1 fails at the **exact same step** with the **exact same
signature** as the optimization-branch runs 2–3: `group-2-count` passes, then
the bare `inventory-group-nostock` assert polls ~17 s and FAILs. The failure
screenshot hierarchy at the base failure shows `inventory-group-2` and
`inventory-row-4` mounted, `inventory-group-nostock` absent, and the fixture
self-check at `11/11 checks passed` — the product list is healthy and the
trailing group is simply not mounted (virtualized below the fold). That is
the flow's own documented virtualization class: the comment directly above
the Garage header prescribes `scrollUntilVisible` before asserting a
below-the-fold header because "a bare assert fails nondeterministically",
and the nostock assert has no such guard (flow lines ~111–128: scrolled
guards for `inventory-group-2` and `inventory-group-2-count`, bare asserts
for `inventory-group-nostock`, `-name`, `-count`).

The base-commit run 2 then **passed 108/108** on the warm bundle with no
other change, confirming nondeterminism rather than a deterministic product
break: the same commit, same flow, same device produces both FAIL and PASS.
A flaky failure was therefore diagnosed from the artifacts first (hierarchy
+ fixture state above), then re-run once per protocol — the re-run passed.

The planned bisect (`f342ea4`, then `f5979d5`) was **not run**: the stop
condition was met (the failure reproduces on the base commit, so it cannot
have been introduced by any of the six optimization commits `2bbfbf7..f5979d5`).

## What could not be determined

- Whether the `f5979d5` list memoization changes the nostock-assert **flake
  rate**. Base shows 1 fail + 1 pass; the branch showed 2 consecutive fails
  after a cold-bundle flake. Single samples cannot distinguish a rate shift
  from noise — that would need repeated runs per commit, which this task did
  not perform.
- Anything past the nostock-header assert on the optimization tip stays
  unobserved (same limitation as the prior report).
- No second device, no percentiles; millisecond figures were never at issue
  here (JUnit carries only step counts and pass/fail).

## State left behind

- Both worktrees in place, nothing deleted: `m3-ab` detached at `9e23749`
  (only the untracked `node_modules` symlink), `optimizations` at `f5979d5`
  (pre-existing `M odd/tasks/optimizations.md` and untracked
  `node_modules` / `odd/tasks/optimizations-device.md` untouched).
- Emulator `emulator-5554` left running; the verification-owned Metro on
  8082 (served from m3-ab) stopped; `adb reverse` left at the pre-existing
  `tcp:8082 tcp:8082`.
- Production `tengo.db` never created, opened, or modified; no `pm clear`,
  no uninstall; only isolated `m1-fixture-*.db` files were used.
- The only file written by this task is this report
  (`odd/tasks/optimizations-m3-ab.md`, the authorized surface).
