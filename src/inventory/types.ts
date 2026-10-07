/**
 * Approved M1 inventory domain types (no persistence, no queries).
 *
 * Every item references exactly one location entity and zero or more
 * categories via the `item_categories` join (see `src/db/migrations.ts`).
 * Repository CRUD and filter queries arrive in M2/M3; this module only
 * describes shapes. `locationId`/`categoryIds` are the domain-side names of
 * the `location_id` / `item_id, category_id` columns.
 */
export interface Location {
  id: number;
  name: string;
  address: string | null;
  created_at: string;
}

export interface Category {
  id: number;
  name: string;
  created_at: string;
}

export interface Item {
  id: number;
  name: string;
  /** Zero means exhausted; distinct UI treatment is deferred past M1. */
  quantity: number;
  locationId: number;
  created_at: string;
}

/** Input for creating a location: name required, address optional. */
export interface NewLocationInput {
  name: string;
  address?: string | null;
}

/** Input for creating a category: independent entity, name required. */
export interface NewCategoryInput {
  name: string;
}

/** Input for creating an item: location required, categories optional. */
export interface NewItemInput {
  name: string;
  quantity: number;
  locationId: number;
  categoryIds?: number[];
}

/**
 * Item read model: the stored row plus its resolved relations — the one
 * required location entity and the zero-to-many category list, with both
 * the foreign-key ids (`locationId`, `categoryIds`) and the entities.
 */
export interface ItemDetail {
  id: number;
  name: string;
  /** Zero means exhausted; distinct UI treatment is deferred past M1. */
  quantity: number;
  locationId: number;
  location: Location;
  categoryIds: number[];
  categories: Category[];
  created_at: string;
}

/**
 * Bounded P3a filter for `queryItems` (see `./itemQuery`).
 * `query` is an optional JS substring; `locationId` null/undefined means
 * all locations; `categoryIds` empty/undefined means no category filter
 * (OR across the selected ids, items deduped).
 */
export interface ItemFilter {
  query?: string;
  locationId?: number | null;
  categoryIds?: number[];
}

/**
 * Draft location selector for the add/edit form: exactly one of an
 * existing location id or a new location name/address. No synthetic
 * defaults; the form must supply one side.
 */
export type ItemLocationDraft =
  | { kind: 'existing'; locationId: number }
  | { kind: 'new'; location: NewLocationInput };

/**
 * Draft category selector: each entry is either an existing category id
 * or a new category name. Zero entries means "no categories".
 */
export type ItemCategoryDraft =
  | { kind: 'existing'; categoryId: number }
  | { kind: 'new'; category: NewCategoryInput };

/**
 * Draft input for the add/edit form: item fields plus related-entity
 * selectors. The repository validates the whole draft, then creates the
 * new location/categories and the item (or item update) in one exclusive
 * transaction — any failure rolls back with no orphan rows.
 */
export interface ItemDraftInput {
  name: string;
  quantity: number;
  location: ItemLocationDraft;
  categories?: ItemCategoryDraft[];
}
