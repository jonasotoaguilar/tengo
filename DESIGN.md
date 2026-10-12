# Design — Tengo inventory by location

Proposed planning design: no inventory screen is wired into the app
yet. The working tree holds the readiness foundation (`App.tsx`
default screen, `src/db/`, `src/i18n/`) plus implemented-but-unwired
building blocks (`src/inventory/` repositories and bounded query,
controlled `src/components/InventoryList.tsx`). This document plans
the MVP UX so implementation can follow it later. Product truth lives in
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
  slice. Approved contract now governs over those sketches: quantity
  zero means exhausted, locations are mandatory entities, categories
  are zero-or-many entities, deletion always confirms with no trash.
  Each remaining default still needs its ROADMAP.md §9 gate before
  build (§10).


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
Inventory (list, grouped/filterable by location)
├── Search (filter on the list, not a separate destination)
├── Add item (name, quantity, required location, zero or more categories)
└── Item (edit fields; delete behind explicit confirm)
```

Location is the organizing principle: the list groups or filters by
place (e.g. Kitchen, Pantry, Garage), and every item shows its
location at a glance. Detail is justified only as the edit surface:
no separate read-only detail screen is proposed; tapping an item
opens it for editing.

## 3. Screens and flows (proposed)

Conventions below: `[ ]` input, `( )` button, `>` row/tap target,
`---` divider. All copy exists in `en` and `es` before build.

### 3.1 Inventory list (default screen)

```text
[Top app bar: Tengo]
[Search field: Search name, place…    ]
[Location filter chips: All | Kitchen | Pantry | Garage | …]
------------------------------------------
KITCHEN                          12 items
> Rice · x2 · Kitchen                48dp
> Olive oil · x1 · Kitchen           48dp
------------------------------------------
PANTRY                            8 items
> Lentils · x4 · Pantry              48dp
------------------------------------------
( + Add item )  one primary action: the FAB on Android.
```

- Behavior: list opens focused on browse; search filters in place;
  chips filter by location; counts are honest (they reflect the
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

- Typing filters the visible list; name matching is the approved
  baseline and multi-category selection filters with OR semantics
  and deduplicated results. Broader location/category text matching
  follows the adopted gate decision (ROADMAP.md section 9).
- Matching is case-insensitive; accent-insensitive folding (`cafe`
  finds `café`) stays a proposal until adopted.
- No-match state: names the query ("No results for 'quinoa'"),
  offers clearing the search or adding it as a new item.
- Search state survives rotation; clearing restores the full list.

### 3.3 Add item

```text
[Top bar: < Back | New item | (Save)]
(Position follows §6; B2/B6 top-bar placement is a historical alternative, not the active Android target.)
Name        [ Rice             ]
Quantity    [ (–)  2  (+)      ]
Location    [ Pantry         v ]
Category    [ Grains (optional)]
[Inline error under the field when invalid]
```

- Save stays enabled except while submitting; validation runs on
  submit and on blur, with inline errors in the current language.
  On a submit with invalid fields, focus moves to the first error.
- Quantity defaults to 1 (proposed); zero is approved and means
  exhausted, with distinct exhausted UI deferred to UI milestones.
- Location is a required entity: name required, address optional,
  free-entry names such as Casa/Bodega. Categories are zero or many
  per item via multi-select (selecting several filters with OR and
  dedup). Bounds, uniqueness, and category-management UI remain
  proposals.
- Cancel/Back with unsaved changes asks to discard (no silent loss).

### 3.4 Edit item (the "detail" surface)

Same layout as Add with title "Edit item". Adds a destructive zone
at the bottom: `( Delete item )` in the error role, requiring the
confirm in section 4. Save confirms with transient feedback
(Snackbar on Android).

### 3.5 Location and category handling (approved entities)

- Locations are mandatory entities, not free-text columns: every
  item references exactly one valid location (name required,
  address optional, free entry). The form therefore selects or
  creates a location instead of accepting an unbound string; the
  boards sketch free-text entry and are unchanged, so the approved
  entity contract governs.
- Categories are independent entities joined to items: zero or many
  per item, no duplicate associations. Multi-select filters with OR
  semantics and deduplicated results.
- Normalization beyond trim, name/address uniqueness, recency or
  suggestion behavior, and any managed-list/category admin UI remain
  proposals. Because locations are entities, an empty place can exist
  without items only if a future gate approves it; until then, a
  location filter with zero matches shows the contextual zero-match
  state in section 4.

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
  `( Delete )`; success is announced transiently. Approved: every
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
  quantity steppers expose value and increment/decrement actions;
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
- `ItemForm`: fields name/quantity/location-entity/categories
  (multi-select), `errors`, `onSubmit`, `submitting`; validation
  messages inline.
- `QuantityStepper`: integer value, min 0 (zero approved as
  exhausted) plus/minus plus direct
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
- Search matches names (approved baseline) plus multi-category OR
  filtering with dedup; accent-insensitive folding (stored text
  verbatim) stays a proposal. Delete always confirms and dismissing
  a dirty form never silently loses input; quantity zero is accepted
  as exhausted with distinct UI deferred.
- Text contrast meets the 4.5:1 floor and controls the 3:1 floor
  (proposed); ROADMAP.md section 7 performance budgets observed on
  a device pass.

## 10. Roadmap cross-links and unknowns

- Milestones: list/search states → ROADMAP.md M3 (query and
  controlled component host-verified; App integration pending);
  add/edit/delete → M4 (pending); strings/a11y/performance/matrix
  → M5 (pending); schema/validation gates → M1–M2 (done; see
  [verified native evidence](docs/testing.md#verified-native-evidence-android-only)).
- Approved contract (overrides the single-text sketches above):
  mandatory location entities (name required, address optional,
  free entry), independent category entities with zero or many per
  item and OR-plus-dedup multi-select filtering, quantity zero
  meaning exhausted with UI deferred, and confirmed deletion with no
  trash. Unknowns still needing gates: numeric/string bounds (such
  as 120/80/999999), name/address uniqueness, category management
  and suggestion behavior, accent-folding semantics, and v1 backfill
  values — never fabricate a location; nonempty v1 rows lacking a
  location preserve rows and stop with a migration-required error
  per ROADMAP.md.
