# Inventory model v2

## Objective and authorization
Update PRODUCT.md, ROADMAP.md and DESIGN.md with approved product decisions, then implement M1 (schema/domain validation), not M2 CRUD or UI. Notify the user when ready to upload; do not push, open PRs or merge. Branch: feat/inventory-model-v2. Existing local documentation commits remain intact.

## Approved contract
Every item must reference a valid location entity. Location name is required; address optional, free-entry names such as Casa/Bodega. Quantity zero is allowed and means exhausted, with distinct UI treatment deferred to UI milestones. Category is an independent entity; an item can have zero or multiple categories. Multiple selected categories match OR, with no duplicate results. Deletion always confirms, no trash. Domain models and database both enforce integrity.

## Constraints and uncertainty
No actual device inventory has been inspected. Do not claim real legacy rows or create synthetic Unassigned locations without approval. A migration must never silently discard rows; if populated v1 data cannot satisfy required location without a product decision, preserve it and block migration explicitly. Numeric/string limits from old docs remain proposals unless technically necessary and identified as implementation guards. No new managed-location/category UI or store distribution. No wireframe source modifications for schema work.

## Tasks
- [ ] T1 (in progress): Record approved decisions and revised M1 schema/validation contract in the three docs; keep proposed bounds and unimplemented UI explicit. Delegate bounded writer, readback/links, documentation work-unit commit.
- [ ] T2: Implement normalized location/category/item-category entities and required item-location relationship, safe migration v2 and domain validation. Test-first RED/GREEN; test empty/v1/v2, invalid/missing relationships, duplicate associations and zero quantity. Verify real SQLite SQL where available; mocked Jest is not native proof. Commit behavior with tests and applicable docs.
- [ ] T3: Run applicable focused and full checks, assess/review exact work-unit under RDD and acknowledge if approved. Record all failed/unavailable native checks. Notify ready for upload only if required checks observed; do not publish.

## Acceptance and verification
Confirmed decisions reflected consistently in docs. No item can be inserted without a valid location; no category join references absent entities or duplicates. Zero quantity accepted; invalid quantity rejected. Migration failure preserves v1 rows/version, not fabricated locations or reset data. Existing foundation test boundary preserved. Commands: focused Jest, npm run test:ci, npm run check, npm run compat, npm run export:smoke. Real native SQLite gate before M2 must be performed or explicitly remain blocked, not replaced by host SQLite evidence.

## Evidence and next step
Baseline explorer: src/db/migrations.ts v1 items(id,name,created_at); src/db/index.ts injectable DatabaseLike; no inventory domain modules; four existing Jest suites mock native SQLite. No current device-row evidence. Begin T1 documentation only.
