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
