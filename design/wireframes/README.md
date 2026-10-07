# Tengo inventory wireframes (low-fidelity, grayscale)

Source authority: [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md),
[ROADMAP.md](../../ROADMAP.md). These boards plan the MVP UX; there is no
runtime implementation — no inventory screens exist in the app yet.

- Editable source: `../tengo-wireframes.op` (OpenPencil document, page
  "Tengo wireframes", boards B1–B9; deferred to a later deliverable,
  not in this slice).
- Static map: `overview.png` (all boards at a glance).
- Static previews: `previews/01-…​09-….png` (one per board, exported from
  OpenPencil after visual inspection for clipping and missing labels).

## Boards

| Board | Screen | OS idiom / notes |
| ----- | ------ | ---------------- |
| B1 | Populated list, grouped by location, chips filter, search, FAB | Android: top app bar + single FAB, 48dp targets |
| B2 | Same list content | iOS: large title, compose-style + Add, no FAB, 44pt targets, edge-swipe back |
| B3 | Search filter + no-results (`quinoa`) | Clear search / Add "quinoa" (prefilled B5); accent-insensitive match |
| B4 | First-run empty | Single "Add your first item" action |
| B5 | Add item form | Name, quantity stepper, free-text location + recency suggestions, optional category |
| B6 | Edit item form | Same fields + destructive "Delete item" zone; transient save confirm |
| B7 | Field-validation state | Inline errors, focus to first error |
| B8 | Database error | Full-state message + Retry; never raw SQLite text |
| B9 | Delete confirm + dirty-form discard | Explicit choice; dismiss never deletes or loses input |

Viewport is 390 wide (phone, ~390x844); content uses an 8pt/dp grid,
16 screen margins, 44pt / 48dp minimum targets, safe-area footers.

## Transitions (numbered ①–⑧ on the boards)

1. B1/B2 entry → FAB / + Add opens B5; tapping a row opens B6.
2. Typing in list search → B3 states; Clear returns to B1/B2; Add "quinoa" → B5 prefilled.
3. First launch → B4; CTA → B5.
4. B5 Save → list + transient confirm; Back with edits → B9 discard.
5. B6 Save → list; Delete → B9 confirm. No separate read-only detail screen.
6. B7: validation on submit + blur; errors announced, not color-only.
7. B8: list DB failure → Retry reloads from the on-device DB.
8. B9: confirm every delete; Back on a dirty form asks before discarding.

## Proposed rules — pending approval, not confirmed

Nothing below is decided; each maps to a ROADMAP.md section 9 gate (G0):

- Quantity: non-negative integer 0–999999, no units, default 1.
- Locations: free text with recency suggestions (trimmed; matched
  case-/accent-insensitively), not a managed list.
- Category: optional free text; search filters by it.
- Delete: confirmed every time, irreversible, no trash/undo in the MVP.
