# Inventory MVP — remaining roadmap

## Objective and authorization
User authorized all remaining ROADMAP milestones M2–M5 after verified M1. Implement local-only Android/iOS household inventory, no backend/accounts/sync/store release. Prior request remains: notify ready to upload; no push, PR or merge. Existing unpublished commits/history preserved on feat/inventory-model-v2; close each bounded work unit with tests/docs and Conventional Commit. Native review candidates are exact work units, never the accumulated branch.

## Contract and implementation choices
Each item references one valid location entity (required name, optional address), has integer nonnegative quantity (zero = visibly exhausted), and zero-to-many category entities. Multi-category filter uses OR and deduplicates items. Confirm deletion, no trash; dirty dismissal confirms discard. Parameterized SQL and typed domain errors. No unapproved product length/quantity caps, name uniqueness, or synthetic locations. UI: native stack where practical, existing/new location selector, category multiselect and inline creation; save new related entities with item atomically, no standalone entity-management screen. Preserve verbatim user text; accent-fold behavior remains proposal until decided, case-insensitive name search baseline. No request for additional product scope.

## Tasks
- [ ] P1 (in progress): M2 location/category persistence foundation with parameterized CRUD/list/fetch and typed errors, domain checks and focused tests. Bounded worker. Prevent deleting referenced location; no entity uniqueness invented.
- [ ] P2: M2 item CRUD with transactional category association and atomic inline entity creation; filtering/read models and error handling; unit tests plus real native isolated repository/restart persistence evidence before M3. Bounded work units if >400 review lines, do not code-golf.
- [ ] P3: M3 app list/search/location+category filters, loading/empty/no-results/retry, exhausted highlight, bilingual strings and UI tests. Native design skills first, preserve dev fixture gate.
- [ ] P4: M4 add/edit, required existing/new location and optional multiple existing/new categories, quantity control, translated inline errors/focus, keyboard/rotation retention, dirty discard and deletion confirmation; component and native flows.
- [ ] P5: M5 accessibility/theme/reduced motion/string audit/performance work with measurable tests and checks; no new product features.
- [ ] P6: Remaining native functional matrix, isolated force-stop/relaunch persistence and extended Maestro flows, full checks and per-unit reviews/acknowledgements; report ready vs blocked, no publication. Android emulator available; iOS requires external macOS/iPhone evidence and cannot be invented.

## Acceptance and gates
Runnable test-first RED/GREEN per behavior; tests and docs alongside behavior. Focused Jest then applicable full test:ci/check/compat/export. Existing real native M1 fixture proved5/5 Android and tengo.db hash preserved. Subsequent native persistence checks use isolated test DBs only, no production-data clear/reset/uninstall. M3 precedes M4 UX; filters OR without duplicates; empty inventory leads to add and can create required location atomically. Dark mode, large text, screen-reader/touch target checks, keyboard/rotation, locale en/es, performance (actual measurements not unverifiable claims). iOS not available locally: P6 stays partial until required iOS evidence. Earlier G0 boards sketch old category field; approved entity contract overrides sketch, no wireframe file churn required for this implementation.

## Verification evidence and progress
Baseline HEAD87dbea385f6b7984f3c9fd1dae11c12372c6affe, clean. M1 domain/schema and dev harness approved/acknowledged; 57 tests,36 host SQL,5 native Android fixtures passed. Existing App only readiness; no repository/UI CRUD. Explorer muxjd82r-n-cdao mapped remaining milestones, no navigation dependency direct yet. Library selection is a technical decision, not delegated to the user; prefer smallest native-suitable approach, explain dependencies before adding any. iOS environment absent. Begin P1 only.
