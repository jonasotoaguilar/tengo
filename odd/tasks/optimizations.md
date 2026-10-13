# Optimizations — search cost, query scale, write path, form renders

Implementation of the optimization findings of the whole-app review (`tengo/optimization-review`), on a feature
branch cut from the delivered `main` (`9e23749`, tree-identical to the reviewed `a2da940`). Six optimizations plus one
measured experiment; each is its own work unit with its own tests, and the delivery is a feature-branch chain that
merges into `main`. This document is the specification the workers read.

## Specs

- **S1** (user, verbatim): "bien, incia todas esas optimizacion y no te detengas hasta que este todo mergeado".
  This authorizes implementation, commits on a feature branch, push, PRs and merge for this scope.
- **S2** — Scope is the review's optimization list, in this order:
  1. **Search keystroke pipeline** — every keystroke re-runs the full read round: `queryItems(db,{})` (for the total)
     plus `queryItems(db,queryFilter)` plus `listLocations` + `listCategories`, with no debounce anywhere.
  2. **`IN (...)` chunking** — `queryItems` builds placeholder lists that grow with the page and break past SQLite's
     variable limit.
  3. **Search read-3 / schema unit (experiment)** — read 3 repeats the location payload per stock row; the folded-column
     or FTS route. Implement, measure on device, revert completely if the budget is not recovered stably.
  4. **Write path** — sequential existence checks and per-row inserts inside the exclusive transaction, and a fresh
     native connection per mutation.
  5. **Error wrapping** — unexpected errors (e.g. a `TypeError`) are wrapped as `StorageError`.
  6. **Form per-keystroke work** — the whole form re-renders per keystroke, `dirty` compares with `JSON.stringify` per
     render, `setRow` copies the whole stock array, and per-render `Set`/filter/parse work plus an effect keyed on
     `values.stock`.
  7. **List memoization** — `InventoryList` uses FlatList defaults with no `React.memo`/`useMemo`/`useCallback`.
  Explicitly **out of scope** (the review said "do not fix"): adding indexes, the uniqueness check-then-write, and the
  modal mounting. Nothing here overrides that.
- **S3** — Every unit preserves the recorded behavior: the accent-folded literal substring (`café` / `CAFÉ` / `cafe`
  all match, and `%`, `_`, `\` are literal), sin-stock visibility, the L9a location view (an item with 0 at the selected
  location but stock elsewhere stays visible, marked), the composed per-row accessibility labels, the impact
  confirmation copy, and the pinned read shape. A unit may change the read count only if it says so in its own commit
  message and updates the pin deliberately, never silently.
- **S4** — Test-first: observe RED before the fix. For every existing behavior the unit touches, add one test proving it
  still holds. Never weaken an assertion to force a pass, and never delete a test to make room.
- **S5** — Unit 3 is an experiment, not a promise: implement it, measure on device against the 200 ms budget with
  repeated runs, and if it does not recover stably, revert it completely (zero diff) and report the measurements.
  A recorded miss is an acceptable outcome; a silent one is not.
- **S6** — Delivery: feature-branch chain with a tracker. Destination policy is binding: `.github/workflows/pr-check.yml`
  fails a PR above 800 authored lines (`package-lock.json` and `.agents/skills/**` excluded), `size:exception` where an
  atomic unit cannot be split. Everything merges into `main`, and nothing merges on a check that is not passing.
- **S7** — There is no production `tengo.db`: DEV fixtures only. Never run a device flow while another worker has
  uncommitted edits in the same worktree.

## Tasks

| ID | Unit | Files (disjoint) | Specs | Route |
|----|------|------------------|-------|-------|
| T1 | Search keystroke pipeline: cache total/locations/categories, debounce the search commit | `src/screens/InventoryContainer.tsx` + its test | S2.1, S3, S4 | writer (parallel) |
| T2 | `IN (...)` chunking in `queryItems` | `src/inventory/itemQuery.ts` + query tests | S2.2, S3, S4 | writer (parallel) |
| T3 | Write path: batch existence checks and inserts, reuse the connection | `src/inventory/itemRepository.ts`, `src/inventory/entityRepository.ts` + tests | S2.4, S3, S4 | writer (parallel) |
| T4 | Form per-keystroke work: memoized derived values, cheap dirty compare, isolated stock rows | `src/components/ItemForm.tsx`, `src/screens/useItemFormController.ts` + tests | S2.6, S3, S4 | writer (parallel) |
| T5 | Error wrapping: only wrap known driver failures | `src/inventory/itemQuery.ts`, `itemRepository.ts`, `entityRepository.ts` + tests | S2.5, S3, S4 | after T2/T3 |
| T6 | List memoization | `src/components/InventoryList.tsx` + its test | S2.7, S3, S4 | after T1 |
| T7 | Search schema unit (experiment) | `src/db/migrations.ts`, `src/db/index.ts`, `src/inventory/itemQuery.ts` + tests | S2.3, S3, S4, S5 | **stopped in phase 1 — recorded miss** |
| T8 | Delivery: chain, PRs, merge | — | S6 | parent + worker |

## Log

- **L1** (user, verbatim): "bien, incia todas esas optimizacion y no te detengas hasta que este todo mergeado"
- **L2** (source of the scope): the read-only review recorded as `tengo/optimization-review` in Engram, produced by two
  explorers over CodeGraph and verified by the parent. Ranked real-cost findings: the search keystroke pipeline, the
  missing pagination/`IN` growth, read 3 repeating the location payload, the per-mutation connection, the wrapped
  unexpected errors, the form's per-keystroke work, and the un-memoized list.
- **L3** (baseline, measured before any edit): `main` = `9e23749`; the branch `feat/optimizations` is cut from it and is
  tree-identical; the recorded search figure to beat is 234–292 ms against a 200 ms budget, with a reverted split that
  measured mean 233.7 → 184.5 ms but 186.8 PASS / 204.7 FAIL / 162.0 PASS.
- **L4** (scope reading, stated explicitly): "todas esas optimizaciones" is read as the six optimizations plus the
  schema experiment, and NOT as the three items the review told us not to touch. Unit 3 is the one that was pending as
  decision #22; implementing it is the "authorize the schema unit" route, and it is measured rather than assumed.
- **L5** (T7, phase-1 STOP — measured on the host, no source edits, worktree clean): the schema route **cannot** serve the current
  search semantics, and this closes decision #22 with evidence instead of opinion.
  - **FTS5 fails in two independent ways.** `unicode61 remove_diacritics 2` folds accents but is token-based: infix substrings
    (`afe`, `caf`) match nothing. `trigram remove_diacritics 2` gives substring matching but returns **nothing for single-character
    queries**, while the pinned tests expect `%`, `_` and `\` to match two items each; bare `%` and `\` are MATCH syntax errors,
    so the path would also need query-syntax escaping for what is currently literal data. No single tokenizer serves folded +
    arbitrary-length literal substring.
  - **A stored folded column states the predicate but cannot stay in sync.** `INSTR(folded, folded_query)` is fully literal, but
    SQLite cannot compute the fold (`lower('CAFÉ') = 'cafÉ'`; no NFD or diacritic strip), so triggers cannot maintain the copy and
    the sync would depend on the write path, which is outside this unit — a guaranteed drift surface.
  - **The benefit is implausible anyway**: read 3 does not repeat the location payload by accident, it **delivers the breakdown**.
    Folded columns widen the rows and FTS still needs the same breakdown reads for its hits, so neither route removes the attributed
    34–92 ms.
  - FTS5 presence is **inferred, not proven**: the vendored SQLite 3.50.3 is compiled with `-DSQLITE_ENABLE_FTS5=1` unless a flag
    disables it, and `app.json` sets none, but the device build was never probed (host is 3.46.1).
- **L6** (delivery plan for this branch): the six units above are the chain; the device re-observation (flows plus the p5b measurement)
  runs on the committed state before the PRs are opened, so the chain carries measured evidence rather than assertions about it.
- **L7** (device re-observation on `f5979d5`, measured): `m4-forms` 107/0, `m4-forms-large-text` 85/0 at 2.0x (scale restored),
  `m6-entities` 124/0 — all green. `p5b-measure` passes 12/0 three times while the **search budget is missed on all three samples:
  248.6 / 213.8 / 238.6 ms against 200 ms** (smallest margin 13.8 ms). That is an improvement on the recorded 234–292 ms and it
  is still a miss; it is recorded as a miss. `m3-query` failed repeatably at the bare `inventory-group-nostock` header assert.
- **L8** (A/B on the base commit, measured): `9e23749` fails at the **same** bare assert with the **same** hierarchy signature
  (group 2 mounted, the nostock group unmounted, fixture 11/11) and then **passes 108/108 on a re-run** with a warm bundle. The flow
  file is byte-identical in both checkouts. Verdict: the failure **predates the optimizations** and is the flow's documented
  virtualization flake, **not** a regression from the list memoization. Left undetermined and stated as such: whether the memoization
  changes the flake *rate* — a single sample per commit cannot resolve a rate. The fix is a flow-side scroll guard, as its own unit.
- **L9** (delivery claims, stated so the PRs cannot overstate them): the search budget is **still missed** and the per-keystroke win
  is pinned by tests (the round no longer repeats the total and the choice lists) rather than by a device number; the list and form
  isolation is proven by memoized components with referentially stable props; the schema route is closed with evidence (L5).
