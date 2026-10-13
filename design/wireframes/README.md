# Tengo inventory wireframes (low-fidelity, grayscale)

Source authority: [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md),
[ROADMAP.md](../../ROADMAP.md). These boards draw the implemented catalog-and-stock
model (DESIGN.md §3): the list with per-item totals and per-location breakdowns, the
form with per-location stock rows and inline location/category creation, and the
managed-entity screen. Copy on the boards follows the English strings in
`src/i18n/resources.ts`.

- Editable source: `../tengo-wireframes.op` (OpenPencil document, page
  "Tengo wireframes", boards B1–B10).
- Static map: `overview.png` (all boards at a glance).
- Static previews: `previews/01-…​10-….png` (one per board, exported from
  OpenPencil after visual inspection for clipping and missing labels).

## Boards

| Board | Screen | OS idiom / notes |
| ----- | ------ | ---------------- |
| B1 | Populated list, general view: one row per item with total + per-location breakdown, location and category filter chips, search, trailing No stock group, location-view note, Manage entry, FAB | Android: top app bar + single FAB, 48dp targets |
| B2 | Same list content | iOS: large title, compose-style + Add, no FAB, 44pt targets, edge-swipe back |
| B3 | Search filter + no-results (`quinoa`) | Clear search / Add "quinoa" (prefilled B5); accent-insensitive match |
| B4 | First-run empty | Single "Add your first item" action |
| B5 | Add item form | Name, per-location stock rows with steppers and per-row Remove, Add location chips incl. New location with inline name + optional address, categories multi-select with New category + Add category, Save |
| B6 | Edit item form | Same fields as B5 + destructive "Delete item" zone; transient save confirm |
| B7 | Field-validation state | Implemented copy: name required, per-row quantity range, duplicate-location error; inline errors, focus to first error |
| B8 | Database error | Full-state message + Retry; never raw SQLite text |
| B9 | Delete confirm + dirty-form discard | Implemented copy; item deletes point at B10 for location/category deletes |
| B10 | Locations and categories (managed entities) | Location rows with Rename/Delete, add-location form (name + optional address), category rows with Rename/Delete, add-category form, location-delete dialog stating existencias removed / items survive / newly unstocked count, category-delete note stating association removal |

Viewport is 390 wide (phone, ~390x844); content uses an 8pt/dp grid,
16 screen margins, 44pt / 48dp minimum targets, safe-area footers.

## Transitions (numbered ①–⑩ on the boards)

1. B1/B2 entry → FAB / + Add opens B5; tapping a row opens B6.
2. Typing in list search → B3 states; Clear returns to B1/B2; Add "quinoa" → B5 prefilled.
3. First launch → B4; CTA → B5.
4. B5 Save → list + transient confirm; Back with edits → B9 discard.
5. B6 Save → list; Delete → B9 confirm. No separate read-only detail screen.
6. B7: validation on submit + blur; errors announced, not color-only.
7. B8: list DB failure → Retry reloads from the on-device DB.
8. B9: confirm every delete; Back on a dirty form asks before discarding.
9. B1 "Manage locations and categories" → B10; rename inline; location delete
   removes its existencias but never items (newly unstocked items stay visible as
   out of stock); category delete removes only the association. Counts in each
   confirmation state the impact.
10. B10 Back → list.

## Implemented rules (were proposed, now built — see DESIGN.md §§3–4)

- Name 1–120 characters; per-row quantity a whole number 0–999999 (blank or 0
  drops the row instead of storing it); location/category names ≤80.
- Locations and categories are managed entities with unique names (accent-aware);
  items hold stock in zero, one, or several locations; categories are zero-or-many
  per item with OR multi-select filtering.
- Search matches the folded query against the item name, any location name where
  it has stock, or any category name; one row per item.
- Items with no stock anywhere trail in the "No stock" group, never hidden.
- A location view shows that location's quantity per row.
- Every delete confirms and states its impact; there is no trash/undo in the MVP.
