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
