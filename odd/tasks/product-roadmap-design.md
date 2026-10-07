# Product Roadmap and Design

## Objective
Create coordinated PRODUCT.md, ROADMAP.md and DESIGN.md for the local-first Tengo household inventory. User approved an MVP organized by location: name, quantity, location, optional category; create, edit, delete and search. No application implementation is authorized.

## Scope and constraints
- Android/iOS, one household, on-device SQLite, English/Spanish; no accounts/backend/sync.
- Apply Impeccable to plan native UI alongside implementation phases.
- Existing source and prior task evidence remain authoritative; distinguish delivered functionality from proposals.
- Documents use English to match repository convention.
- No commits without explicit user request; no UI code, dependency changes or generated images.

## Tasks
- [x] D1 (complete): Create the three coordinated documents and structurally verify evidence, links, scope, acceptance criteria and unresolved decisions.
  - Route: delegated worker; multiple non-trivial documents and preparation reading.
  - Acceptance: detailed dependency-ordered roadmap, native UX/design specification, confirmed product record, truthful verification limitations.
  - Checks: read back documents; validate local links and alignment against code; no runtime tests applicable to documentation-only work.

## Delivery
One documentation work unit; no commit authorized. Forecast: approximately 300–500 authored documentation lines; no publishing requested.

## Evidence
Prior read-only exploration covered README.md, App.tsx, src/db/, src/i18n/, package.json and existing odd/tasks/ records. Builds/tests were not executed in that review.

## Verification outcome
PRODUCT.md (156 lines), ROADMAP.md (308 lines) and DESIGN.md (262 lines) created. Worker structurally checked 10 relative document links and referenced source paths. Parent readback prompted one correction batch covering immediate UX gates, truthful baseline claims, form validation, migration/native persistence evidence and proposed contrast/performance/token contracts; parent spot-checked the corrected G0/M1 sections. No tests, builds, emulators, screenshots, staging or commits run: documentation only. Existing package.json modification reported by worker was left untouched. Limits, colors, quantity semantics, locations/categories and deletion remain proposals pending approval.

## Next step
Review DESIGN.md wireframes and ROADMAP.md G0 decision gates before authorizing application implementation.
