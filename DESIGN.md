# Design — Tengo inventory by location

Design contract. The inventory UI is implemented on the v4 model:
the list with search, location and category filters, the add/edit form with
per-location stock editing and inline location/category creation, and the discard and delete
confirmations. The Android verification cited below now includes a pass on the
catalog-and-stock model: the four Maestro flows were re-run on it and all pass,
with the search figure missing its budget as recorded in `docs/testing.md`.
Section 3 therefore describes built behavior, and section 5
carries the approved token values through `src/theme/tokens.ts`. The
defaults that were deferred — trimmed bounds, name uniqueness, accent
folding, and location/category text matching — were adopted and implemented
on 2026-10-12, and the managed-entity screen was adopted by the user and
implemented on the same date (its device verification is still pending);
address uniqueness was never adopted. Product truth lives in
[PRODUCT.md](PRODUCT.md); build order and acceptance live in
[ROADMAP.md](ROADMAP.md) (M1–M5, gates, checklist).

## Source artifacts and wireframe boards

Editable boards are the spatial reference; the text sketches in
section 3 are supporting sketches. PRODUCT.md is the scope authority
and this document (DESIGN.md) is the behavior contract: if boards,
sketches, or prose contradict PRODUCT.md or each other, reconcile
explicitly — do not silently change product scope or behavior.

- Editable source: `design/tengo-wireframes.op`
  (page "Tengo wireframes", boards B1–B9; deferred to a later
  deliverable, not in this slice).
- Static map: [design/wireframes/overview.png](design/wireframes/overview.png)
  (all boards at a glance).
- Board notes: [design/wireframes/README.md](design/wireframes/README.md)
  (board notes, numbered transitions ①–⑧, pending-approval rules; B2 idiom is historical).
- Per-board static exports: `design/wireframes/previews/01–09-*.png`
  (one PNG per board, exported after visual inspection).

| Board | Content | Maps to |
| ----- | ------- | ------- |
| B1 | Populated list, chips filter, search, FAB | Active Android target for §3.1 |
| B2 | Same list content, large title, compose-style Add | Historical alternative to §3.1, not the active Android target (artifact name unchanged) |
| B3 | Search filter + no-results (`quinoa`) | §3.2 |
| B4 | First-run empty, single CTA | §4 empty first-run |
| B5 | Add item form | §3.3 |
| B6 | Edit item form + destructive zone | §3.4 |
| B7 | Field-validation state | §4 field errors |
| B8 | Database error + Retry | §4 DB failure |
| B9 | Delete confirm + dirty-form discard dialogs | §4 destructive / §3.3–3.4 |

Main transitions (full numbered list ①–⑧ in the board notes):

- Active path: list B1 → Add B5 via FAB; row tap → Edit B6. B2 is a historical alternative, not the active Android target.
- List search → B3 states; Clear returns to B1 (B2 is historical only); Add "quinoa" → B5 prefilled.
- First launch → B4; CTA → B5.
- B5/B6 Save → list with transient confirm; dirty Back → B9 discard dialog.
- B6 Delete → B9 confirm dialog; no separate read-only detail screen.
- B8 DB failure → Retry reloads from the on-device DB.

Reading notes:

- B1/B2 are historical OS variants of the same list, not a sequence; only B1 is the active Android target. B3–B9 are
  states of that list and its form, not a linear flow.
- Arrows on the static map show reachability between boards; they are
  not a clickable prototype.
- Boards are low-fidelity grayscale with English example copy. They do
  not prove `es` parity, theme tokens, contrast, screen-reader behavior,
  or runtime behavior — §§5/7/9 specify requirements that still need
  implementation checks and a device pass.
- All recommended defaults shown on the boards (quantity range,
  free-text locations, single optional category, irreversible delete)
  were proposed when drawn and the boards are unchanged in this
  slice. Approved contract now governs over those sketches: per-location
  stock rows (one quantity per location, the total is the sum), items with
  no stock shown as "sin stock", stock in zero, one, or several
  locations per item, categories
  as zero-or-many entities, location deletion cascading stock but never
  items (category deletion removing only the association, each
  confirmation stating the impact), and deletion
  always confirming with no trash.
  The remaining defaults were adopted at the ROADMAP.md §9 gate on
  2026-10-12; §10 lists what is still open.


Mode: Operate. The visitor completes a task (find it, record it,
update it). Scanability, native expectations, and consistency outrank
expression. Brand lives in precise details, not decoration.

## 1. Visual direction and rationale

Quiet stockroom: a calm, legible tool that reads like a well-kept
storage shelf. Restrained color strategy (Operate default): neutral
surfaces tinted from the platform plus one accent reserved for
primary actions, selection, and state. No tabs-for-show, no
dashboard, no marketing ornaments.

- Rationale: the job is lookup and capture under real-world
  conditions (kitchen, garage, one-handed). Familiar platform
  controls beat custom chrome; density and clarity beat personality.
- World in one line: the visual language of labeled shelves and
  storage bins — grouped, scannable, honest about quantity.
- What it refuses: card-stack abundance, gamified counts, dark
  neon, serif display type in buttons and labels.

## 2. Information architecture

One primary list, one creation/edit path, search as a first-class
filter. No forced tab bar: the MVP is shallow enough for a single
stack.

```text
Inventory (list, general view plus per-location views)
├── Search (filter on the list, not a separate destination)
├── Add item (name, per-location stock, zero or more categories)
└── Item (edit fields; delete behind explicit confirm)
```

Location is the organizing principle: the list groups or filters by
place (e.g. Kitchen, Pantry, Garage). The general view shows each item
once with its total and per-location breakdown; a location view shows
that location's quantity (the filter is a membership test: "has stock
there"); a trailing group holds items with no stock anywhere
("sin stock"). Detail is justified only as the edit surface:
no separate read-only detail screen is proposed; tapping an item
opens it for editing.

## 3. Screens and flows (implemented; the four Maestro flows re-observed on the new model, with the search budget miss recorded in `docs/testing.md`)

Conventions below: `[ ]` input, `( )` button, `>` row/tap target,
`---` divider. All copy exists in `en` and `es` before build.

### 3.1 Inventory list (default screen)

```text
[Top app bar: Tengo]
[Search field: Search name, place…    ]
[Location filter chips: All | Kitchen | Pantry | Garage | …]
------------------------------------------
General view: one row per item, total plus breakdown
> Rice · x6 total (Kitchen x2 · Pantry x4)   48dp
> Olive oil · x1 · Kitchen                   48dp
------------------------------------------
Location view (e.g. Pantry): that location's quantity
> Rice · x4 · Pantry                         48dp
------------------------------------------
NO STOCK
> Quinoa · sin stock                         48dp
------------------------------------------
( + Add item )  one primary action: the FAB on Android.
```

- Behavior: list opens focused on browse; search filters in place;
  the location filter is a membership test (the item has stock there);
  the general view shows each item once with its total and per-location
  breakdown, a location view shows that location's quantity, and a
  trailing group holds items with no stock anywhere ("sin stock");
  counts are honest (they reflect the
  current filter).
- Search has exactly one affordance: the inline search field. No
  separate search icon or second entry point.
- Group headers show item counts. Location filters come from location
  entities (see §3.5); a location filter with
  zero matches shows the contextual zero-match state in section 4,
  not an empty header.
- Primary action only: one Add action opening the form (FAB on
  Android, never stacked; B2 sketches a historical compose-style
  button, not the active target).

### 3.2 Search

- Typing filters the visible list; an item matches when the folded
  query is a substring of its name, any location name where it has
  stock, or any of its
  category names (adopted and implemented 2026-10-12, ROADMAP.md
  section 9), and multi-category selection filters with OR semantics
  and deduplicated results; an item matching several ways appears once.
- Matching is case- and accent-insensitive in both directions (`cafe`
  finds `café`, `CAFÉ` finds stored `cafe`); stored text is returned
  verbatim.
- No-match state: names the query ("No results for 'quinoa'"),
  offers clearing the search or adding it as a new item.
- Search state survives rotation; clearing restores the full list.

### 3.3 Add item

```text
[Top bar: < Back | New item | (Save)]
(Position follows §6; B2/B6 top-bar placement is a historical alternative, not the active Android target.)
Name        [ Rice             ]
Stock by location (optional)
  Kitchen   [ (–)  2  (+)      ]  (Remove)
  Pantry    [ (–)  4  (+)      ]  (Remove)
  (Add location — may create a location inline while saving)
Category    [ Grains (optional)]
[Inline error under the field when invalid]
```

- Save stays enabled except while submitting; validation runs on
  submit and on blur, with inline errors in the current language.
  On a submit with invalid fields, focus moves to the first error.
- Stock is edited per location: one row per location with its quantity
  (typed or stepped, starting blank via
  `blankItemFormValues` in `src/screens/useItemFormController.ts`),
  a remove action per row, and an add-location action; a blank or
  zero quantity means "no stock there" and drops the row rather than
  storing it. A new location can still be created inline while saving
  the item.
- An item may hold stock in zero, one, or several locations: locations
  are entities (name required, address optional,
  free-entry names such as Casa/Bodega). Categories are zero or many
  per item via multi-select (selecting several filters with OR and
  dedup). Bounds (name 1–120, quantity 1–999999 per stock row with 0
  dropped, location 1–80,
  category 80) and name uniqueness are adopted and implemented, and so is
  the category-management UI (adopted and implemented on 2026-10-12,
  device verification still pending).
- Cancel/Back with unsaved changes asks to discard (no silent loss).

### 3.4 Edit item (the "detail" surface)

Same layout as Add with title "Edit item". Adds a destructive zone
at the bottom: `( Delete item )` in the error role, requiring the
confirm in section 4. Save confirms with transient feedback
(Snackbar on Android).

### 3.5 Location and category handling (approved entities)

- Locations are entities, not free-text columns: an item may hold stock
  in zero, one, or several locations (name required,
  address optional, free entry). The form therefore edits one row per
  location instead of a single quantity field; the
  boards sketch single-quantity free-text entry and are unchanged, so the approved
  entity contract governs.
- Categories are independent entities joined to items: zero or many
  per item, no duplicate associations. Multi-select filters with OR
  semantics and deduplicated results.
- Name uniqueness is adopted and implemented: an accent-aware domain
  check produces the typed conflict error and the v3 unique index is
  the backstop. Normalization beyond trim, address uniqueness, recency
  or suggestion behavior, and any managed-list/category admin UI remain
  unimplemented. Deleting a location cascades its stock rows and never
  deletes items; deleting a category removes only the association with
  items. Each confirmation states the impact; `LocationInUseError` no
  longer exists. A
  location filter with zero matches shows the contextual zero-match
  state in section 4, and items with no stock anywhere appear in the
  trailing "sin stock" group rather than disappearing.

## 4. Interaction, loading, empty, error, destructive states

- Loading: skeleton rows for the list; Save disabled only while
  submitting, input preserved. No bare centered spinner as content.
- Empty first-run: teaches the job ("Nothing here yet — add what
  you keep and where you keep it") with a single `( Add your first
  item )` action. Not a bare "nothing here".
- Empty search or zero-match location filter: names the query or
  place ("No results for 'quinoa'" / "No items in 'Garage'");
  offers `( Clear search )` and, for a name query, `( Add "<query>" )`.
- Errors: field errors inline (name required, quantity invalid);
  DB failure shows a full-state message with `( Retry )`; raw
  SQLite text never reaches the screen.
- Destructive: delete opens a confirm dialog naming the item
  ("Delete 'Rice'? This cannot be undone.") with `( Cancel )` /
  `( Delete )`; success is announced transiently. Deleting a location
  or category likewise confirms and states the impact (how many
  existencias go; the items themselves are never deleted that way).
  Approved: every
  delete confirms and there is no trash/undo in the MVP.
- Feedback motion: 150–250 ms state transitions only; no
  orchestrated load sequences; reduced-motion settings replace
  slides/parallax with crossfade or instant.

## 5. Tokens, typography, spacing, touch (approved)

Semantic role tokens only — raw hex never drives UI, so light/dark
resolve per theme:

- Roles mapped per platform (approved values; `src/theme/tokens.ts` is
  the single source, and raw hex never drives UI outside it):

  | App role | Android M3 role | Light | Dark |
  | -------- | --------------- | ----- | ---- |
  | background | background | #FFFFFF | #121212 |
  | surface | surface | #F4F2EC | #1C1C1E |
  | primary action | primary / onPrimary | #2F6B3A / #FFFFFF | #7BC79A / #0B2E18 |
  | secondary container | secondaryContainer | #E5E1D5 | #2C2C2E |
  | control outline | outline | #8A8578 | #6E6E73 |
  | separator (decorative) | outlineVariant | #C9C5B8 | #38383A |
  | error | error / onError | #B3261E / #FFFFFF | #FFB4AB / #410002 |
  | label | onBackground | #1A1C19 | #F2F1ED |
  | secondary label | onSurfaceVariant | #5C5F58 | #AEB0AD |
- Contrast floor (approved): text at least 4.5:1 against its background;
  interactive control boundaries at least 3:1 against both the background
  and the surface. The `control outline` role carries the 3:1 floor —
  light 3.68:1 on the background and 3.38:1 on the surface, dark 3.69:1
  and 3.37:1 — while `separator` stays light because WCAG 1.4.11 does not
  apply to decoration. `__tests__/contrast-floor.test.tsx` renders the
  production surfaces in both schemes and fails if any control boundary
  drops below the floor. Focus indicators are drawn by the platform and
  are not measured.
- Light: paper-neutral background, one tonal step for grouped
  headers/filter chips; dark: true dark scheme (not an invert),
  tonal elevation per Material 3.
- One accent carries primary actions, selection, and focus; never
  decoration or inactive states.
- Type: system faces only in the MVP (Material type scale Body/Title/Label on
  Android in `sp`). One family across the app; tighter scale
  (1.125–1.2). Prose measure 65–75ch where prose appears.
- Spacing: 8dp base grid; 16 screen margins; 8 between related
  rows, 16+ between groups; more space above a header than below it.
- Touch: 48x48 dp minimum on Android, 8dp
  gaps between adjacent targets.

## 6. Native navigation and system behavior (Android)

- Android: top app bar for screen context plus single FAB for Add;
  system Back and predictive Back always work; bottom sheets and
  Material dialogs/snackbars per Material 3.
- Guarantees: edge-to-edge layout inside safe
  area and window insets (notch, home indicator, status/navigation
  bars); keyboard (IME) insets keep Save and focused fields
  visible; no control hides behind system bars or the keyboard.

## 7. Accessibility, reduced motion, i18n

- Every interactive element has a localized screen-reader name;
  per-location quantity steppers expose value and increment/decrement actions;
  errors are announced, not color-only.
- Type follows system font-scale settings;
  layout is verified at a large size without truncation.
- Reduced motion (Android Remove animations):
  crossfade or instant cuts; content visible by default.
- All strings live in `src/i18n/resources.ts` with `es` parity
  enforced by the existing `typeof en` lock; Spanish is verified on
  a real `es` locale pass, not assumed from English.

## 8. Component contracts (proposed)

- `InventoryList`: props `items`, `state: loading|empty|error|
  ready`, `onSearch`, `onFilterLocation`, `onOpenItem`; never
  fetches directly.
- `SearchField`: controlled query, clear action, accessible label;
  stateless filtering owned by the list.
- `LocationChips`: `locations`, `selected`, `onSelect`; horizontal
  scroll, 48dp minimum targets.
- `ItemForm`: fields name/per-location stock/categories
  (multi-select), `errors`, `onSubmit`, `submitting`; validation
  messages inline.
- `QuantityStepper`: integer value per stock row (blank or zero means
  "no stock there" and drops the row) plus/minus plus direct
  entry; exposes a11y value.
- `DeleteConfirm`: item name, `( Cancel )`, `( Delete )`; returns
  an explicit choice, never deletes on dismiss.
- `EmptyState` / `ErrorState` / `ListSkeleton`: content, action,
  and retry slots; no hardcoded copy.

## 9. UI acceptance criteria

- List, search, add, edit, and delete all work offline with both
  languages; no screen shows untranslated or hardcoded text.
- Empty, loading, error, no-match, and delete-confirm states match
  sections 3–4 on Android.
- Touch targets, type scaling, screen reader, dark scheme, keyboard
  behavior, and safe-area handling meet sections 5–7.
- Search matches the item name, any location name where it has stock, or any category name
  with accent folding (adopted and implemented; stored text verbatim)
  plus multi-category OR filtering with dedup. Delete always confirms
  and dismissing a dirty form never silently loses input; a 0-quantity
  row is dropped rather than stored and items with no stock appear in
  the trailing "sin stock" group.
- Text contrast meets the 4.5:1 floor and control boundaries the 3:1
  floor, implemented in `src/theme/tokens.ts` and guarded by
  `__tests__/contrast-floor.test.tsx`; ROADMAP.md section 7 performance
  budgets were measured on a device pass, where search measured 292.6ms
  against the 200ms per-keystroke budget on the catalog-and-stock model
  and is recorded as a FAIL (it was 174.6ms before the model change).

## 10. Roadmap cross-links and unknowns

- Milestones: list/search states → ROADMAP.md M3 (done; App
  integration verified on Android); add/edit/delete → M4 (done);
  strings/a11y/performance/matrix → M5 (done, with TalkBack speech a
  stated boundary); schema/validation gates → M1–M2 (done; see
  [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- Approved contract (overrides the single-text sketches above):
  location entities (name required, address optional,
  free entry) with stock in zero, one, or several locations per item,
  independent category entities with zero or many per
  item and OR-plus-dedup multi-select filtering, a stock row always
  meaning something stored there (0-quantity rows dropped; no-stock
  items shown as "sin stock"), location deletion cascading stock but
  never items (category deletion removing only the association, each
  confirmation stating the impact), and confirmed deletion with no
  trash. Closed by adoption on 2026-10-12: numeric/string bounds, name
  uniqueness, accent-folding semantics, and location/category text
  matching. Still needing a gate: address
  uniqueness, suggestion behavior, and the v4
  rebuild rule — the managed-entity screen was adopted and implemented on
  2026-10-12. Never fabricate a location; the v4 migration carries
  one stock row per old item with `quantity > 0` under a
  preserve-and-stop guard per ROADMAP.md (the v1 backfill rule stands
  as the record of that earlier migration).
