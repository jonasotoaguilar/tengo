# Inventory Wireframes

## Objective
Create editable low-fidelity OpenPencil wireframes based on PRODUCT.md, ROADMAP.md and DESIGN.md. No application implementation.

## Scope
Inventory list, search/location filtering, add/edit with location suggestions, first-run/no-results, validation/database error, delete/discard confirmation. Use approved fields; proposed defaults remain marked pending. Preserve existing OpenPencil user work by creating an isolated document/page. No image generation, application changes, commits or publishing.

## Tasks
- [x] W1 (complete): Create native mobile wireframes in design/tengo-wireframes.op and export review previews to design/wireframes/; add a concise design/wireframes/README.md explaining flows and proposals.
  - Route: delegated worker for multi-surface design creation and context preparation.
  - Acceptance: editable artifact saved; main flows and states represented; platform differences annotated; preview reviewed for clipping and missing labels.
  - Checks: OpenPencil document readback, one batched visual review and at most one correction/confirmation round; no runtime tests applicable.

- [x] W2 (complete): Correct overlapping board positions and add labeled flow connections.
  - Route: delegated worker; OpenPencil layout plus exported overview and guide.
  - Acceptance: all nine boards spatially separated, OS variants identified rather than sequential, branches and return actions labeled, complete canvas inspected and overview exported.
  - Checks: persisted absolute board bounds non-overlap, whole-page screenshot pixel inspection, existing board content preserved.
  - Reason: user screenshot disproved W1 canvas-layout readiness; individual previews did not verify whole canvas.

## Evidence and constraints
Impeccable context already loaded once this session. Existing design is planning only. PRODUCT.md confirms local inventory by location, name/quantity/location/optional category, Android/iOS, en/es. Build workflow/image generation remains unset and not needed for structural wireframes. Generated artifact copy defaults English per repository convention.

## Delivery
One design artifact work unit; no commits authorized. No UI source diff forecast. Application tests/builds not applicable.

## Verification outcome
Created 9 editable boards B1–B9 on isolated Tengo wireframes page. Saved design/tengo-wireframes.op; exported 9 PNG files to design/wireframes/previews/ and flow guide design/wireframes/README.md. Worker inspected all board screenshots, fixed clipped annotations in one batch, and confirmed; lint reported 27 intentional layout warnings, no errors. Parent viewed Android list preview as a pixel spot check. Original Page 1 retained untouched and included in saved document. No application tests/builds/device runs or commits; design-only evidence, not functional validation.

## W2 outcome
Saved explicit positions for all 9 boards; worker saved-file bounds check found no overlap (page n3, x 100–1030, y 120–3937). Added labeled editable gutter arrows; exported design/wireframes/overview.png. Parent viewed whole overview pixels and confirmed separated boards and connections. Initial problem: B2–B9 lacked persisted x/y, defaulting to origin. README map update skipped to minimize requested correction. No app code/tests/builds/commits.

## Layer cleanup
- [x] W3 (complete): Group titles, notes and flow connections; replace cryptic layer names. Mechanical delegated cleanup of design/tengo-wireframes.op only; preserve all global coordinates and board contents. Acceptance: organized root groups, descriptive names, save/readback, no redesign or extra exports.

W3 evidence: saved .op has 12 page roots (9 boards plus Titles and lane headings, Notes, Flow connections). 115 loose layers grouped/renamed; 368 pre-existing node coordinates unchanged; Page 1 preserved. Flow connections contains rails and arrowheads subgroups, not per-flow subgroups. Worker save/readback succeeded; no runtime tests or new exports.

## Next step
Review organized layers in saved .op. DESIGN.md wireframe-link update is separately in progress.

## Current slice caveat (docs/inventory-plan-documents)
Committed-source evidence (see planning-delivery-unblock.md): the original committed .op has only the Tengo wireframes page — Page 1 claims above are historic worker reports, not confirmed by committed bytes. Editable `design/tengo-wireframes.op` is deferred to a later deliverable; this slice carries docs + static previews only.
