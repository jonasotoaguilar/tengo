# Multi-location stock — catalog + existencias por ubicación

Feature document for the model change the user authorized on 2026-10-12: an item
becomes a catalog entry (identity) and its quantity moves to a per-location
stock table, so "where do I have milk?" has one answer with a breakdown.

Read this document until `## Log` before implementing anything.

## Specs (verbatim, from the user)

- S1 — user, verbatim: "Si, agremos pantalla para categorias y ubicaciones que dices. Pero hay que considerar las reglas, como que pasa si se borra y categoria con items que la usan. Que pasa si se borra una ubicacion, si se debe concervar al menos una ubicacion, que pasa si se borra una ubicacion con items que pasaria con los items/cantidad. Si los items son por ubicacion o se pueden relacionar con una o varias con su respectiva cantidad.\n\nAgregemosla pero revisa el diseno actual y ver bien las reglas, si van en la db o en el backend o ambos."
- S2 — user, verbatim: "Pero que pasaria si un item esta en mas de una ubicacion? Como si quisiera responder en que ubicacion tengo leche? si son diferentes se complicaria, ademas de poder tener diferentes nombres, id. Podria ser mejor cambiar ese modelo"
- S3 — user, verbatim: "Tambien podriamos permitir borrar ubicacion pero pidiendo confirmacion y recordando que eso borrara todos los items asociados (su cantidad/relacion, no el item en si, pues seria aparte ahora)."
- S4 — user, verbatim: "Con todo aclarado procede a implementar el cambio en el backend y ui, revisando primero el diseno de ambos."

## Settled rules (derived from S1–S4; these are what workers implement)

- R1 (S2) — **Identity is separate from storage.** `items` is the catalog: name
  (and later a unit). `stock(item_id, location_id, quantity)` is what is stored
  where. One item may have stock in many locations, each with its own quantity.
  The current model fuses the three into one row and is replaced.
- R2 (S2) — **One answer per product.** List and search show the item ONCE with
  its per-location breakdown and a total; an item present in two locations is
  not two rows with two names and two ids.
- R3 (S3) — **Deleting a location deletes stock, never items.** Confirmation
  states the impact ("N existencias se borrarán; los ítems NO se borran") and
  the DB cascades `stock.location_id`. Catalog items survive.
- R4 (S1) — **Deleting a category deletes only the association.** Confirmation
  states the impact ("se quitará de N ítems; los ítems NO se borran"). Items
  survive.
- R5 — **An item is deleted only explicitly**, from the item itself. Never as a
  side effect of deleting a location or a category.
- R6 (S4, parent recommendation accepted) — **An item left with no stock
  anywhere stays visible as "sin stock"** (total 0). It is not hidden, so a
  location deletion cannot create invisible items. The delete confirmation
  reports how many items end up in that state.
- R7 (S1) — **Layer split, as the project already does it.** The DB carries the
  hard integrity (FK cascades for stock and for the category association,
  unique names, CHECKs); the domain counts the impact BEFORE deleting, performs
  the delete in one transaction, and raises typed, localized errors.
- R8 (S1) — **No minimum number of locations.** Zero locations stays a valid
  state (first run already has its own UI), and deleting the last one is
  allowed.
- R9 (S1) — **No quantity recomputation exists to get wrong**: quantity lives on
  the stock row, so a location deletion either removes that row (R3) or, in a
  future reassignment, moves it with its quantity intact.
- R10 — **Units stay out of scope here.** A single unit per item is the natural
  follow-up decision, not part of this change.
- R11 (S1) — **The entity-management screen (D6) is built AFTER this change**,
  on the final model, so it is not written twice.

## Design (reviewed 2026-10-12, from a read-only map of both layers)

### Backend — schema v4

```sql
-- catalog: identity only
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(TRIM(name)) > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- stock: what is where
CREATE TABLE stock (
  item_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0 AND quantity <= 9007199254740991),
  PRIMARY KEY (item_id, location_id),
  FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
);
CREATE INDEX idx_stock_location_id ON stock (location_id);
```

- `quantity > 0` on purpose: a stock row means "hay algo acá". "Cero / sin
  stock" is the absence of a row, so there is no way to store a contradiction.
  An item's total is `SUM(quantity)`, and 0 when it has no rows (R6's "sin
  stock").
- `stock.location_id ON DELETE CASCADE` is the inversion R3 asks for: deleting
  a location removes stock, and can no longer be blocked by `RESTRICT`.
- The v3 unique expression indexes on locations/categories are untouched.

### Migration v4 — the rebuild, with the trap called out

`items` loses two columns, and SQLite cannot `DROP COLUMN` a column that an
index or a foreign key uses, so the table is rebuilt. The rebuild MUST follow
the SQLite procedure, because the obvious order silently destroys data:
`item_categories.item_id REFERENCES items(id) ON DELETE CASCADE` means a plain
`DROP TABLE items` with foreign keys ON cascade-deletes every category link.

1. `PRAGMA foreign_keys=OFF` **outside** the transaction (inside it, the pragma
   is a no-op — this is the single most dangerous detail of the change).
2. In one transaction: create the new catalog as `items_new` and copy
   `id, name, created_at`; create `stock`; insert one row per old item **with
   `quantity > 0`** carrying its `location_id` and `quantity`; `DROP TABLE
   items`; `ALTER TABLE items_new RENAME TO items`.
3. Preserve-and-stop guard, in the spirit of the v3 TEMP trigger: abort the
   migration (typed error, rows and version untouched) if the copied catalog
   count differs from the old item count or the stock sum differs from the old
   quantity sum. Never rewrite, never invent a location, never backfill.
4. `PRAGMA foreign_key_check` must come back empty, then commit, then
   `PRAGMA foreign_keys=ON`.
5. Version bump in the same transaction; no downgrade; `SCHEMA_VERSION = 4` and
   `MIGRATIONS[4]` added, nothing else touched in the ladder.

`src/db/index.ts`'s `applyMigration` currently runs every migration with
foreign keys ON inside one transaction, so it must gain the FK-off/check/FK-on
envelope for v4 while leaving v2 and v3 exactly as they are.

### Domain and repository

- `ItemDetail{id, name, created_at, stock: StockLevel[], totalQuantity,
  categoryIds, categories}` with `StockLevel{locationId, location, quantity}`.
- Input: `NewItemInput{name, stock: Array<{locationId, quantity}>, categoryIds?}`;
  the draft variants keep `ItemLocationDraft`/`ItemCategoryDraft` per row, so the
  form can still create a location or category inline while saving an item.
- Validation: every stock row needs a valid location id and a quantity inside
  the S10 bounds; a 0-quantity row is dropped rather than stored (it means "no
  hay nada acá"); duplicate location ids in one payload are rejected.
- `resolveDraftRelations` becomes plural: it resolves every stock row's location
  (existing or new) inside the same exclusive transaction, so an item with
  three new locations either commits all three or none.
- `LocationInUseError` and the `RESTRICT` mapping become obsolete (a location is
  no longer blocked by its stock). Removing them is required by the project rule
  against compatibility layers; the delete flow instead asks the domain for an
  impact count.
- New domain read for the confirmations: `locationDeleteImpact(locationId)` and
  `categoryDeleteImpact(categoryId)` returning how many stock rows / how many
  items would be affected, so the copy can state it (R3, R4).

### Read shape (`itemQuery`, still bounded)

- Read 1: the item page (`id, name, created_at`) with an optional membership
  filter `EXISTS (SELECT 1 FROM stock s WHERE s.item_id = i.id AND
  s.location_id = ?)` for the location filter, plus the unchanged category-OR.
- Read 2: category links for the page ids (unchanged, bound placeholders).
- Read 3: `SELECT s.item_id, s.quantity, l.* FROM stock s JOIN locations l ON
  l.id = s.location_id WHERE s.item_id IN (…) ORDER BY s.item_id, l.id` — this
  replaces today's separate locations read, so the breakdown AND the location
  names arrive in one batched read and the bound stays three.
- The S9 text predicate keeps its semantics on raw rows: folded substring over
  the item name, any category name, or any location name where the item has
  stock. An item with no stock rows is a legitimate "sin stock" result.
- An empty page still exits after one read; a category-OR miss after two.

### UI

- List: grouping by location stays (that is the product), and each row shows the
  quantity of THAT location. The general view ("Todas") shows the item's total
  with its breakdown; a location filter switches to that location's view, where
  the row shows that location's quantity. A trailing group holds items with no
  stock anywhere (R6).
- OPEN, asked and awaiting the answer: in a location view, does an item with 0
  there but stock elsewhere appear marked "sin stock" with its breakdown (a,
  parent's recommendation) or not appear at all (b)? Only the contents of that
  view depend on the answer; nothing else in the change does.
- Form: the single quantity field becomes a per-location editor — one row per
  location with its quantity and a remove action, plus "agregar ubicación" —
  reusing the existing inline-creation pattern for a new location.
- Entity screen (T6) comes after, on this model.

## Tasks

- T1 (one atomic unit, because the type change is not committable in halves):
  schema v4 + migration envelope + domain + repository + query + DEV fixtures +
  every backend test. Worker A (backend) then Worker B (UI) land edits on the
  branch; the commit happens only when the whole tree is green.
- T2: the entity-management screen (D6) on the new model.
- T3: Maestro flows updated to the new model and re-observed on device.
- T4: docs/record, then the final checks.

## Log

- L1 — user, verbatim: "Si, agremos pantalla para categorias y ubicaciones que dices. Pero hay que considerar las reglas, como que pasa si se borra y categoria con items que la usan. Que pasa si se borra una ubicacion, si se debe concervar al menos una ubicacion, que pasa si se borra una ubicacion con items que pasaria con los items/cantidad. Si los items son por ubicacion o se pueden relacionar con una o varias con su respectiva cantidad.\n\nAgregemosla pero revisa el diseno actual y ver bien las reglas, si van en la db o en el backend o ambos."
- L2 — user, verbatim: "Pero que pasaria si un item esta en mas de una ubicacion? Como si quisiera responder en que ubicacion tengo leche? si son diferentes se complicaria, ademas de poder tener diferentes nombres, id. Podria ser mejor cambiar ese modelo"
- L3 — user, verbatim: "Tambien podriamos permitir borrar ubicacion pero pidiendo confirmacion y recordando que eso borrara todos los items asociados (su cantidad/relacion, no el item en si, pues seria aparte ahora)."
- L4 — user, verbatim: "Con todo aclarado procede a implementar el cambio en el backend y ui, revisando primero el diseno de ambos."
- L5 — parent: D6 (the standalone managed-entity screen) is hereby ADOPTED, reversing the earlier recorded contract line "no standalone entity-management screen". The reversal is explicit and comes from L1 ("Si, agremos pantalla para categorias y ubicaciones"); it is scheduled after the model change per R11.
- L6 — parent, verified evidence for the cost estimate quoted to the user: 30 files touch `location_id`/`locationId`, 16 of 27 test suites depend on the model, all 3 device flows verify location, and the core to rework is ~3,700 lines (`itemQuery` 415, `itemRepository` 555, `InventoryList` 801, `ItemForm` 1096, `useItemFormController` 821).
- L7 — parent, current model as verified in `src/db/migrations.ts`: `items.location_id INTEGER NOT NULL` with `FOREIGN KEY ... ON DELETE RESTRICT`, quantity on `items`, `item_categories` with both FKs `ON DELETE CASCADE`, unique expression indexes on `lower(trim(name))` for locations and categories (v3), `SCHEMA_VERSION = 3`.
- L8 — parent, T1 backend receipt (worker mv5mv21d-i-ngfn): schema v4 with the FK-off envelope and a preserve-and-stop TEMP-trigger guard mapped to the new `MigrationIntegrityError`; domain, repository and query rewritten to the stock shape (`ItemDetail{stock,totalQuantity}`, `NewItemInput{stock[]}`, plural all-or-nothing draft resolution, zero rows dropped, duplicate locations rejected, S10 bounds per row); `LocationInUseError` and its RESTRICT mapping removed per R3 and replaced by `locationDeleteImpact`/`categoryDeleteImpact`; `itemQuery` is three batched reads with an `EXISTS` membership filter and one stock+locations join; the DEV fixtures and `scripts/verify-inventory-schema.py` kept truthful, with the v2-era NOT NULL/RESTRICT assertions moved to the cascade shape rather than deleted. Evidence: RED observed in six suites (migrations 14, validation 6, entity 6, item-repository 16, item-query 10, db-init envelope), GREEN 172/172 across 11 focused suites and 183 including `exclusive-database.test.ts`; `python3 scripts/verify-inventory-schema.py` passed 36 checks on real host SQLite 3.46.1, including the demonstration that an FK-ON rebuild destroys the category links and that R3's cascade works; `tsc` is clean in every backend surface with the remaining 31 errors confined to the UI files this change has not adapted yet. Device proof is still pending and belongs to T3.
- L9 — parent: the location-view contents question (a/b) was still unanswered when the UI work started, so the UI implements the parent's recommendation (a): in a location view, an item with 0 there but stock elsewhere appears marked "sin stock" with its breakdown visible. Answering (b) changes one condition in the list, nothing else.
- L10 — parent, label decision: the Spanish copy already says "Ubicación" (7 keys) and its placeholder shows a single example ("p. ej. Despensa"). Recorded decision: keep "Ubicación" — it is the standard, neutral term and already verified in the flows and docs — and widen the placeholder to show the range ("p. ej. Heladera, Alacena, Casa 1"), which is what actually communicates that the name is free. Correctable by the user at any time before T3 rewrites the flow assertions. The optional "Dirección" field fits "Casa 1" but not "Heladera" and is recorded as the first candidate to drop if the entity is ever simplified.
- L11 — parent, T1 CLOSED and committed as `a29ddf0` (35 files, 4312 insertions / 1995 deletions, 6307 changed lines), amended once to drop the last dead import the model change left behind. Tree clean, `npm run check` exit 0 with no warnings, 27 suites / 437 tests. The UI half (worker mv5ngbk7-j-5siz) landed the general view with total plus breakdown, the location view, the trailing "sin stock" group and the per-location stock editor with its five new bilingual keys and the widened placeholder.
- L12 — parent, NATIVE REVIEW REFUSED by the provider for this candidate, verbatim: `lens_context_budget_exceeded` — "The candidate's complete reviewer evidence exceeds the native context budget, so no review authority was created; review this change as smaller candidates that each fit under it." Recorded rather than worked around: `mutation_outcome: not_started`, `authority_applicability: not_evaluated`, `retry_safe: true`, `next_action: stop`, and the allocated id carries no authority. An earlier attempt with three lenses was rejected as `lenses-invalid` before that. CONSEQUENCE, stated plainly: the most consequential change of this project currently carries NO native review, because the change is atomic — the type change cannot be committed in halves without leaving a broken commit — and its 35 paths / 6307 changed lines do not fit the reviewer's context budget. What does exist: the writer's self-verification (27 suites / 437 tests, `npm run check` exit 0, `scripts/verify-inventory-schema.py` 36 checks against real host SQLite 3.46.1 including the FK trap demonstration) plus an independent verifier (mv5odeak-k-yal8) whose findings are awaited. If delivery is ever requested, this candidate needs restructuring into a reviewable series; that is a user decision and is not assumed here.
- L13 — parent, INDEPENDENT VERIFICATION of `a29ddf0` (worker mv5odeak-k-yal8) returned VERIFIED on all seven items, reading the code rather than the test names: the FK-off envelope with the trap demonstrated twice (the shipped script seeds a v3 database with two category links, migrates, and both links survive; the same SQL with foreign keys ON leaves zero), the data mapping (catalog rows byte-identical, an old quantity of 0 becoming a stockless catalog item, and the guard provably able to fire), the read shape (exactly three read sites, `EXISTS` membership, one `stock JOIN locations` read, bound placeholders only, the S9 predicate intact, no unreadable row able to match), the domain (all-or-nothing plural resolution on the exclusive handle, zero rows dropped with the duplicate check running BEFORE the drop, S10 per row, R3's cascade leaving items alive), the adversarial coverage pass (about 40 removed `test(` calls, each with a new-shape counterpart and no guard silently disappearing), the UI claims, and the rest (`npm run check` exit 0 and 27 suites / 437 tests observed). Its findings, with their disposition:
  - The guard's rollback was proven only through a rigged conflict, never by firing the shipped trigger inside `applyMigration` while asserting `user_version` and row counts stay untouched: being closed by a new regression test (worker mv5ok2ya-m-283n).
  - The location membership filter is not used by the app — the container stops sending `locationId` so the location view can show 0-there items per L9a — but it is NOT dead code: the DEV query fixture calls it (`src/dev/nativeQueryFixture.ts:581-582`) and the m3-query flow asserts the location-AND-category-OR case on device. A focused unit test is being added instead of deleting the filter.
  - `npx jest --ci` in its parallel form failed 5 of 437 once and passed on rerun, while the `--runInBand` form that `test:ci` uses is green: being characterized by five parallel runs in the same worker, with a root cause required and no retries or weakened assertions permitted.
  - The verification flagged a worktree mutation during its own run. That was this document being written by the parent (L11-L12), not a stray process; recorded so the anomaly is not left unexplained.
  - The exact commit stat is 35 files, 4312 insertions, 1995 deletions (6307 changed lines); L11's earlier "1994" was off by one and is corrected there.
- L14 — parent, documentation sweep receipt (worker mv5ohllu-l-89mq): PRODUCT.md, DESIGN.md, ROADMAP.md, README.md and docs/development.md were updated in place so that no statement still describes the v2/v3 single-location model. Every new-model device claim is marked pending and the historical device records are qualified as previous-model observations. The before/after greps are the evidence: the first pass hit PRODUCT 26/73-75/92, DESIGN 68/103/291, ROADMAP 17/35/130/195/257, README 49-50 and docs/development 41; the after pass leaves only truthful new-model lines (`LocationInUseError` no longer exists, per-row steppers, the cascade rule). Name uniqueness, the trimmed bounds, accent folding, cross-entity search, zero-locations-valid and the still-unimplemented managed-entity screen were left intact, and no document was restructured. The parent separately updated `docs/testing.md` (the model-change banner, the fixture dataset note, and the correction that the flows were NOT adapted) and this document's receipts.
  - FLAGGED and deliberately not done: the wireframe artifacts (`design/tengo-wireframes.op`, `design/wireframes/overview.png`, `design/wireframes/previews/`) still draw the old single-quantity form and the old list. DESIGN.md records them as unchanged sketches governed by the new contract; redrawing them is a separate unit and is surfaced rather than assumed.
  - `npm run check` was red when the worker finished, solely because an untracked test file from the parallel unit needed formatting — outside its surfaces, and correctly left alone.
- L15 — parent, native review of the verification-closure range (`a29ddf0..e4ace80`: the three regression tests plus the documentation sweep). The assess reported medium risk with `reviewDue: true` (reason `slice_budget_reached`, 10 paths / 922 changed lines, large writer profile, no separate verifier required). This candidate DID fit the reviewer's budget, unlike the model change itself: review `review-be5a376a68a0a043`, one consolidated reliability lens, 10 files / 922 lines, approved and acknowledged, authority burned (consumed revision sha256:599ccd76aec8269b59493cd45f661f55dc2f7de331ddb22b4c602f57ae6305e1). The contrast is the concrete evidence behind L12's recommendation: the same provider refused the 6307-line candidate outright and accepted this 922-line one, so a re-split into candidates of this size is the way to get the model change reviewed.
- L16 — parent: the entity-management screen (D6) is being built by worker mv5ot11g-n-u8l0 on the new model, reusing the existing repository functions so name uniqueness and the trimmed bounds stay enforced by the domain, with delete confirmations that state the impact through `locationDeleteImpact` / `categoryDeleteImpact`.
- L17 — parent, sequencing decision for the flows (worker mv5ovkq1-o-v6e8): T3 is deliberately split in two. The flow rewrite runs now, because the flows only need the code — every testID and every expected count is derived from `InventoryList`, `ItemForm`, `useItemFormController` and the DEV fixtures rather than guessed, and `npm run verify:flows` is the gate. The device re-observation waits until the `src/` tree is quiet, because a bundle served while another unit holds uncommitted source edits is an inconsistent snapshot; that exact mistake already produced a misleading native crash earlier in this project. The flows still target the old model's testIDs and counts today, and `docs/testing.md` says so.
- L18 — parent, entity-screen receipt (worker mv5ot11g-n-u8l0): `src/components/EntityManager.tsx` manages both entity kinds exclusively through the functions that already exist, so S11 uniqueness and S10 bounds stay domain-enforced and the typed errors surface as localized inline copy rather than storage text. The delete confirmations are the point of the screen and read their numbers from `locationDeleteImpact` / `categoryDeleteImpact`: a location states how many existencias are removed, that the items are NOT deleted, and how many are left visible as "sin stock"; a category states that only the association is removed from N items. The list gains a manage action that is disabled with an honest hint when mutations are off, and the container hosts the screen in the same modal pattern as the form with a background refresh after an entity write. 25 new bilingual keys with `es` parity, 48dp targets, accessible labels and the approved contrast tokens. Evidence: RED (the new suite could not resolve the module before the screen existed), GREEN 14 entity-manager tests, 77 across the four focused suites, 31 suites / 461 tests and `npm run check` exit 0. Three initial failures were test-assertion bugs and were fixed in the tests, not by touching the implementation. Device verification is NOT claimed: dark mode, large text and TalkBack on this screen remain unobserved, and no device command was run.
- L19 — parent, flows receipt (worker mv5ovkq1-o-v6e8): the three Maestro flows were rewritten for the v4 model with every selector and every count DERIVED from the code and recorded with its `file:line` source rather than guessed — the list's group and row testIDs, the form's indexed per-location rows, the fixture's seeded dataset and the container's view-only location handling. `m3-query.yaml` keeps its coverage and re-derives it: the groups including the trailing stockless group, the total plus breakdown rows, the folded search variants, the literal percent case, the location-view counts, the location-AND-category-OR case, dedup, no-results and clear, the empty first run, and the injected fault with its single-keystroke retry. `m4-forms.yaml` and its 2.0x variant move to the per-location editor with inline location creation and keep the edit, discard, delete and restart-persistence paths, with explicit scrolls before every below-the-fold tap. `p5b-measure.yaml` needed no change and was verified aligned, and the flow guard rejected nothing, so neither the guard nor its test was touched. `npm run verify:flows` passes over all five flows. The counts are derived statically and have NOT been observed on a device: the fault case in particular is expected to need confirmation in the device re-observation, which is the next unit.
- L20 — parent, review receipt for the entity-screen unit (`e4ace80..71427d7`, the range as it stood when the review ran; it was 15 paths and 1697 changed lines then, and that range now extends further so the stat no longer reproduces at HEAD). The candidate the controller offered ambiently was the whole branch (82 paths, base = the merge-base with `main`), which is exactly the shape the provider already refused, so the review ran as an exact unit with an explicit base: the base it pinned is the tree of `e4ace80` (`338438f8…`, a tree object, not a commit), and `git diff --stat` over it reproduces the same 15 files / 1601 insertions / 96 deletions. Lineage `review-01f977b32e4fd049`, one consolidated reliability lens, tier medium, correction budget 200, and the candidate paths in the actor binding are exactly the fifteen files of the unit. The reviewer ran as one host-relayed model run — forecast first, then the acknowledged run — returned **approved** on the last admitted event, and the acknowledgement burned the authority (`consumed_revision sha256:193ee3d7…`, target `sha256:42cfdfb7…`), after which a fresh status reports `stop / target_already_acknowledged`. The lineage and target identities are re-derivable from the 259-byte consumption record under `.git/gentle-ai/review-transactions/terminal-consumption/v1/`; the consumed revision exists only in the acknowledgement output the provider returned, so it is recorded as what the provider said rather than as something a later reader can re-check. The closure carried ONE advisory finding, non-blocking and informational: `R3-address-path` at `src/components/EntityManager.tsx:170`, WARNING severity. Its prose is NOT exposed to this session — the closure gives the identity, lens, location, severity and disposition only, and the store under `.git/gentle-ai` holds the 259-byte consumption record rather than the artifact — so it is recorded with that limitation instead of being called fixed or accepted: reading that path directly, the create call passes the raw name and address and the domain normalizes both (`normalizeName` trims and bounds the trimmed length, `normalizeAddress` trims and nulls blanks), and the rename call passes `editing.address`, so a rename does not wipe the address. No defect could be reproduced from the location alone, and the item stays open as its own follow-up.
- L21 — parent, device re-observation receipt (worker mv5p6e0v-p-ctyo): all four flows pass on emulator-5554 against v4 — `m3-query` 108 steps with zero failures, `m4-forms` 107, `m4-forms-large-text` 85 at 2.0x and `p5b-measure` 12 — and the counts that had been derived from the code matched what the device shows, including the fault case's two-of-five rows, the Garage-and-Tools intersections and the exhausted row that reports its own location. Nine scroll steps were added — six in `m3-query.yaml` and three in the large-text flow — because the list virtualizes; every insertion carries the observation that produced it, the single removed line was a comment, and no assertion text, count or selector changed (commit `a325606`, whose message says seven steps: the diff is authoritative and that count is wrong). The measurement pass carries one honest miss: search 292.6 ms against the 200 ms budget, up from 174.6 ms, moved by the storage read the new model needs. It is recorded as FAIL and left unwaived, with the note that a repeated measurement must come before the cost is attributed to a specific read, and that raising the budget is not on the table because the number came from the product's own section 7. Every measurement figure here was read from the device screen: the run artifacts back the four step counts and the zero-failure result, and none of them carries the milliseconds, so the FAIL rests on the recorded reading rather than on a re-derivable artifact. The worker served only from a clean `src/` tree, restored `adb reverse` to `tcp:8082 tcp:8082`, restored `font_scale` to 1.0, stopped both Metro instances, cleared one stale WIP-seeded fixture database through `run-as` and never created, opened or modified the production database. Two environmental flakes were observed and changed nothing: a `hideKeyboard` BACK that exited to the launcher, and one Maestro CLI `IOException` on top of a real assertion failure.
- L22 — parent, search-regression diagnosis (worker mv5qn574-q-h736): the figure was measured three more times on the same protocol, seed and emulator with a clean tree — **263.3, 234.2 and 242.1 ms**, every one a FAIL with at least 34 ms of margin and every one below the recorded 292.6 ms single sample — so the miss is stable with roughly ±15 ms of noise rather than one unlucky run. The cost was attributed with code evidence: reads 1 and 2 keep the previous model's shape, and only read 3 grew, from a `locations` lookup over the distinct survivor location ids (about five rows for this seed) to `stock JOIN locations` over every survivor item id (about five hundred rows, repeating the location payload per item), a delta of about +70 to +90 ms. The worker kept ZERO edits, and its reasoning is the reason: narrowing read 3 needs the location-name verdict read 3 itself produces, a `LIKE` prefilter would miss the accent-folded matches the product pins, a fourth read breaks the asserted three-read bound and adds the bridge round trip that dominates on a device, and trimming the join's columns drops data the display path needs. Recovery needs an index- or migration-level change (a folded generated column with an index, or full-text search), which is a product decision carrying its own migration. `npm run check` and the 31 suites / 461 tests stayed green with no source change, and the run left the tree clean with Metro stopped, `adb reverse` restored to `tcp:8082 tcp:8082` (the wrapper had removed it) and `font_scale` back to 1.0.
- L23 — parent, post-alignment re-observation (worker mv5rahvf-s-83zo): the Expo patch alignment changed the JavaScript bundle, so the four flows were re-observed on it instead of being assumed to still hold. All four pass — `m3-query` 108 commands, `m4-forms` 107, `m4-forms-large-text` 85 at 2.0x and `p5b-measure` 12, every one with zero failures and `failures=0` in its JUnit. `m3-query` failed once first, and the worker diagnosed that failure from the artifacts rather than retrying blindly: the recorded hierarchy at the failing step is the launcher home screen (its ids are `com.google.android.apps.nexuslauncher`), and the worker's own report names the foreground app as NexusLauncher. That is the `hideKeyboard` BACK flake L21 already records, so one diagnosed re-run was the correct response and no flow edit was warranted. The measurement on this bundle reads search **272.6 ms** against the 200 ms budget — the fifth sample of a stable miss (292.6, 263.3, 234.2, 242.1, 272.6) — with first-viewport 230.5/1000 PASS, write 39.8/100 PASS, layout 104.2 (no budget) and seed 23256.3 (unbudgeted setup). The worker also stated in its own report that the figures are read from the screen through a UI dump and are not artifact-backed, which matches what the documents now say. Zero files changed and the tree stayed clean. The worker reported that both Metro instances were stopped with their pids verified gone, that `adb reverse` was restored, that `font_scale` went back to 1.0 and that the device holds only the three isolated fixture databases with no `tengo.db` — and that hygiene claim is NOT independently verified: after the next unit ran, a Metro was still listening on port 8083 (pid 3009260), so at least one instance survived the pass that claimed to have stopped it. It was stopped afterwards, and the bundle that pass served was still the clean tree (only `.maestro/` was modified, and a flow file does not affect the bundle), so the device evidence stands even though the process hygiene claim does not. A later `pkill` aimed at that Metro also matched the shell running it and killed that shell first, which is why the check had to be redone with a pattern that cannot match itself.
- L25 — parent, verification of the entity flow and the defect it found (worker mv5sptny-w-7odw): the derivation table did NOT hold as written. Ten citations are off by one to eight lines (`entity-close` is at :321 not :323, `entity-delete-dialog` at :670 not :678, `entity-category-1-delete` at :507 not :505, the Spanish category message at :254-255 not :253-254, the Spanish rename title at :249 not :250, and `ItemForm`'s quantity testID is used at :662 rather than at the :546 constant), and the table omits eight selectors the flow actually asserts (`crud-fixture-screen`, `inventory-add-empty`, `inventory-empty-title`, `inventory-row-1` with its `-quantity`/`-exhausted`/`-location` children, `inventory-count`, `inventory-group-nostock`). The impact numbers are VERIFIED against `entityRepository.ts:244-272` for this flow's data — 1 stock row at the location and 1 item left unstocked — and the copy assertions do match the rendered strings. It also found a REAL product defect: the impact copy has no singular form, so a destructive confirmation renders "1 stock entries … 1 items will be left" and "Se eliminarán 1 existencias … 1 artículos quedarán", while the app already carries the convention in `inventoryGroupCountOne`/`Other`. Both locales are wrong and the flow was asserting the ungrammatical strings, which is exactly how a green flow hid it — and it only became visible because the flow was extended to exercise a NONZERO impact, since a zero never renders a number. The fix is a unit of its own, with the flow's derivation table corrected in the same pass. One further limitation is recorded: the run artifacts hold the log, the command list and the device logcat but no screenshots or video, so per-assertion text is backed by command success rather than by reviewable pixels.
- L26 — parent, the entity screen's device verification and the copy defect it exposed (workers mv5s6vki-u-w449, mv5sf2yl-v-xldn and mv5t6y33-y-n4vg; verifier mv5sptny-w-7odw): `.maestro/m6-entities.yaml` is the first flow for the managed-entity screen, and it retires the "device verification pending" claim that `DESIGN.md` and `PRODUCT.md` carried. It reaches the screen from the list, creates a location with an address and a category, renames the location and asserts the row's rendered name, deletes one of each through the impact confirmations, and proves the deletes survive a force-stop and relaunch. It passes on emulator-5554 at 89 commands, and at 124 after it was extended to exercise a NONZERO delete impact — an item holding its only stock row in the location being deleted — with `failures=0` in both runs. That extension is what exposed the defect: the confirmation's copy had no singular form, so the dialog rendered "1 stock entries … 1 items will be left" and "Se eliminarán 1 existencias … 1 artículos quedarán", and the flow had been asserting those ungrammatical strings, which is exactly how a green flow hid it. The fix (`c754c46`) follows the convention the list already uses — a singular/plural pair per clause plus a shared clause, with the caller choosing the form — and the corrected copy was then confirmed on the device (124 commands, zero failures). The same verification corrected the flow's derivation table (ten citations off by one to eight lines, eight asserted selectors missing) and confirmed that the impact numbers follow from the repository's own semantics. Live caveats: TalkBack speech on this screen is unobserved, and the artifacts carry no screenshots or video, so per-assertion text rests on command success rather than on reviewable pixels.
- L27 — parent, verification of the copy fix and the citation correction (verifier mv5tdh1h-z-s6jo): the fix's locale parity, its agreement for 0, 1 and 2 in both locales, the tests that pin the copy with explicit negatives, and the flow's citations into `resources.ts` were all VERIFIED. It also found that every citation into `src/components/EntityManager.tsx` was off by exactly one line — the worker re-derived them from a base that had already shifted — which a mechanical check confirmed as a uniform delta of −1 and which was corrected by recomputing each number from the source; the fifteen citations that resolve literally now all match, and the templated ones point at the template that builds them. Two claims of that verification are themselves wrong and are recorded as such rather than repeated: it said `dist/ci-export` ships a pre-fix bundle, but `dist/` is in `.gitignore` and `git ls-files dist` is empty, so that build output is untracked and ships nowhere; and it listed `item-form/name` at :489 as suspect, when that is precisely where the testID is used (the same literal also appears at :165 as a constant). The RED for the copy fix was observed but not logged, so its evidence is the test diff rather than an artifact — the same distinction the documents now make for the measurement figures.
- L24 — parent, correction from the delta verification (worker mv5s12c7-t-toop): the alignment commit's message says the fix "touched nothing else", and that is WRONG. `package.json` did change only `expo` (`~57.0.27` → `~57.0.28`) and `jest-expo` (`~57.0.5` → `~57.0.6`), but `package-lock.json` moved **28 transitive versions across 30 package blocks in 145 changed lines**, all of them in the Expo and Babel toolchain — `@expo/cli`, `@expo/fingerprint`, `babel-preset-expo`, `expo-modules-autolinking`, `prebuild-config`, `@babel/helper-create-regexp-features-plugin` (7.29.7 → 7.29.10) and `regexpu-core` among others — which is what a lock re-resolution by the project's own `expo install --fix` produces. I asserted the smaller claim after reading only the `package.json` diff and extrapolating to the lock, and a commit message cannot be edited without rewriting history, so the correction lives here. The churn is real and upstream's; the evidence that it is benign is that `compat`, `check`, `export:smoke` and the full suite (31 suites / 461 tests) are green on it and that the four device flows pass on the bundle it produces. The same verification confirmed the corrected claims, the receipts, the screen-read-versus-artifact distinction and the newest pass against the run artifacts, and it corrected one phrase of L23: the hierarchy at the failing step is the launcher home screen by its `com.google.android.apps.nexuslauncher` ids, while the foreground app name comes from the worker's report rather than from that hierarchy.
