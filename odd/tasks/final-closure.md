# Final closure of the Tengo MVP

Specs and tasks for the four items the user authorized on 2026-10-12 with
"implementalo todo lo restante", after the roadmap itself was closed.

## Specs

S1 — The search budget must be recovered **if a proportional change can do it**.
The acceptance gap is measured: 234–292 ms against the 200 ms budget, five
samples, attributed to read 3 fetching about five hundred rows with the location
payload repeated per item. The pinned search semantics must not change: a literal
substring match over the item name, its location names and its category names,
accent-folded, one row per item, in stable id order. If no proportional change
recovers the budget, the miss stays recorded and the schema-level options are
reported with their semantics risk rather than adopted silently.

S2 — The wireframes must draw the model the app now implements: the list with each
item's total and per-location breakdown plus the trailing "sin stock" group, the
form with per-location stock rows and inline location creation, and the
managed-entity screen. The editable OpenPencil source stays the source of truth
and the derived previews are regenerated from it.

S3 — The advisory `R3-address-path` must be disposed of with a stated reason:
either a real defect fixed in its own commit, or accepted with the reasoning that
no defect is reproducible from the location it names — recorded together with the
limitation that the provider did not expose the finding's prose to this session.

S4 — The model change must become reviewable as a series. `a29ddf0` (35 paths,
6307 changed lines) is refused by the native reviewer's context budget as one
candidate, and the series must let each part be reviewed while the branch's final
content stays byte-identical, so the existing content-addressed receipts keep
their target identities.

## Tasks

T1 (S1) — attempt the proportional recovery: split read 3 into a light read for
the predicate and a narrow read for the visible page, measure three times on the
device, keep it only if the measurement recovers the budget, otherwise report the
evidence and revert. Route: worker, device run, verifier. Commit: its own.

T2 (S2) — redraw the wireframes for the implemented model and regenerate the
previews. Route: worker with the `openpencil-design` skill. Commit: its own.

T3 (S3) — dispose of the advisory with its reasoning recorded. Route: inline
(documentation). Commit: with T2's documentation or its own.

T4 (S4) — split the model change into a reviewable series on a copy branch, in a
worktree, leaving the current branch and its receipts intact, with a sha mapping
recorded. Route: inline, then one review per range. Commit: the series itself.

## Log

L1 — user, verbatim: "implementalo todo lo restante"
L2 — T2 done (worker mv5v1ypc-12-0g77): the boards now draw the implemented model. B1/B2 carry two-line rows (the name, then the total and the per-location breakdown), a categories filter, the trailing NO STOCK group and a Manage entry; B5/B6 carry per-location stock rows with steppers, a per-row Remove and the add-location chips including inline creation with name and address; B7 carries the implemented error copy and bounds; B9 carries the implemented delete and discard copy; and a NEW B10 draws the entity screen with create, rename and delete and its impact-stating confirmations. The previews and the overview were regenerated from the source and the guide rewritten to match. One caveat is recorded rather than hidden: the OpenPencil CLI/MCP is NOT available in this environment (no binary, not on npm), so validation ran as a strict structural check over the document (0 errors, 10 boards, no overlaps) plus a full visual review, and the exports came from a purpose-built scratch renderer whose fidelity is best-effort — the committed PNGs are byte-identical re-renders of the saved source. What that leaves unverified is whether the real OpenPencil tooling opens the edited `.op`: the file is structurally sound and renders, but no official tool has read it here. The group and dialog counts in the boards are illustrative examples, the same convention the earlier boards used.
L3 — T1 done (worker mv5v1yo9-11-fw9e): recorded in `odd/tasks/multi-location-stock.md` as L29, with the six raw device figures, the revert and the schema-level options and their semantics risk.
L4 — T2's review, REFUSED by budget: the wireframes change was assessed as an executable change (medium, 16 paths, 4232 changed lines) and the native review was refused with `lens_context_budget_exceeded` — lineage `review-42fc62065b1dc4c2`, no review authority created. The refusal is about size, not about the artifact being unreviewable in principle: the OpenPencil document alone carries **4156 changed lines** (3573 additions, 583 deletions) before the eleven regenerated PNGs, so even a split that isolated the source from its derived previews would still exceed the budget that accepted 1697 lines and refused 6307. The design artifact change therefore carries no native review, recorded as such rather than worked around. What partially covers it is not a review: the worker's structural validation (0 errors, ten boards, no overlaps) and a full visual pass over every regenerated preview, plus the fact that the committed PNGs are byte-identical re-renders of the saved source.
L5 — T4 in progress: the series exists on `feat/inventory-model-v2-reviewable` (7 slices, `6da30e5` → `8f76094`, final content byte-identical to `4932d6c`). Slice 1 (the schema, 1259 lines, tier high, four lenses) reviewed and approved, authority burned; slice 2 (the domain, 1484 lines, tier medium, one lens) reviewed and approved with one non-blocking advisory `R3-001` at `src/inventory/entityRepository`'s neighbour `itemRepository.ts:1`, authority burned. Slice 3 (the query) has its forecast pending, and slices 4 to 7 follow the same route. The operational fact that made this work: the controller's candidate is the WORKSPACE tree against the base, so the worktree must be checked out AT the slice being reviewed, not at the branch tip — otherwise the candidate is the whole branch again and the provider refuses it, which happened once (`review-d263aa28a72122e3`, no authority created).
L6 — T4 DONE: the series is reviewed end to end. Slices 1 to 6 were each approved by the native reviewer with their authority burned — slice 1 at tier high with four lenses over 1259 lines, slice 2 at tier medium with one lens over 1484 lines and one non-blocking advisory (`R3-001` at `src/inventory/itemRepository.ts:1`), slice 3 over 567 lines, slice 4 over 526, slice 5 over 1765 (the largest, and it was accepted, which corrects the ceiling I had inferred from the 1697-line candidate), and slice 6 over 523 — and slice 7, the feature document, came back approved at tier low with NO reviewer runs at all, which is the provider's own judgement that a documentation-only candidate needs none. The worktree was returned to the branch tip and the identity re-proven there: `git diff feat/inventory-model-v2-reviewable 4932d6c` is empty, so the series' content is byte-identical to the unsplit change and the receipts that name content-addressed identities still hold. What the series does NOT fix is stated so nobody discovers it later: its intermediate commits do not build, because the schema, the domain, the query, the UI and the fixtures change together, so a bisect across the series lands on broken states. The series exists to make each part reviewable, and it is documented as that rather than as a clean history.
