/**
 * Inventory domain types: catalog identity plus per-location stock.
 *
 * Identity is separate from storage (R1): `items` is the catalog (name
 * only) and `stock(item_id, location_id, quantity)` records what is
 * stored where. One item may have stock in many locations, each with its
 * own quantity; a stock row means "hay algo acá" (`quantity > 0`), and an
 * item with no stock rows anywhere stays visible as "sin stock" (R6).
 * Repository CRUD and filter queries live in `./itemRepository` and
 * `./itemQuery`; this module only describes shapes. `locationId` /
 * `categoryIds` are the domain-side names of the `location_id` /
 * `item_id, category_id` columns.
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

/** Catalog row: identity only, no quantity, no location. */
export interface Item {
  id: number;
  name: string;
  /** Reminder level, or null when the item has no reminder (U2). */
  lowStockThreshold?: number | null;
  /** Scanned identity, or null when the item has no code (U2). */
  barcode?: string | null;
  created_at: string;
}

/** One stock row: how much of an item sits at one location. */
export interface StockLevel {
  locationId: number;
  location: Location;
  quantity: number;
  /** ISO expiry of this stock row, or null when it has none (U2). */
  expiresOn?: string | null;
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

/** One stock entry of an item input: location plus its quantity. */
export interface NewItemStockInput {
  locationId: number;
  quantity: number;
  /** Optional ISO expiry for this stock row (U2). */
  expiresOn?: string | null;
}

/**
 * Input for creating an item: name plus zero or more stock rows plus
 * optional categories. Zero rows means catalog-only ("sin stock").
 * A 0-quantity row is dropped rather than stored; duplicate location ids
 * in one payload are rejected (see `./validation`). The U2 reminder and
 * identity fields are optional, so existing callers keep compiling.
 */
export interface NewItemInput {
  name: string;
  /** Optional reminder level; null/absent means no reminder (U2). */
  lowStockThreshold?: number | null;
  /** Optional scanned identity; null/absent means no code (U2). */
  barcode?: string | null;
  stock?: NewItemStockInput[];
  categoryIds?: number[];
}

/**
 * Item read model: the catalog row plus its per-location breakdown with
 * the total, and the zero-to-many category list with both the
 * foreign-key ids (`categoryIds`) and the entities. An item present in
 * two locations is one row with a breakdown, never two rows (R2).
 */
export interface ItemDetail {
  id: number;
  name: string;
  /** Reminder level, or null when the item has no reminder (U2). */
  lowStockThreshold?: number | null;
  /** Scanned identity, or null when the item has no code (U2). */
  barcode?: string | null;
  stock: StockLevel[];
  /** Sum of the stock quantities; 0 when the item has no rows (sin stock). */
  totalQuantity: number;
  categoryIds: number[];
  categories: Category[];
  created_at: string;
}

/**
 * Bounded filter for `queryItems` (see `./itemQuery`).
 * `query` is an optional JS substring matched (case- and accent-folded,
 * literal) against the item name, the names of locations where the item
 * has stock, and any of its category names; `locationId` null/undefined
 * means all locations (membership: the item has stock there);
 * `categoryIds` empty/undefined means no category filter (OR across the
 * selected ids, items deduped).
 */
export interface ItemFilter {
  query?: string;
  locationId?: number | null;
  categoryIds?: number[];
}

/**
 * Draft location selector for one stock row of the add/edit form:
 * exactly one of an existing location id or a new location
 * name/address. No synthetic defaults; the form must supply one side.
 */
export type ItemLocationDraft =
  | { kind: 'existing'; locationId: number }
  | { kind: 'new'; location: NewLocationInput };

/**
 * Draft stock row for the add/edit form: a location selector plus the
 * quantity at that location. A 0 quantity means "no hay nada acá" and is
 * dropped rather than stored.
 */
export interface ItemStockDraft {
  location: ItemLocationDraft;
  quantity: number;
  /** Optional ISO expiry for this stock row (U2). */
  expiresOn?: string | null;
}

/**
 * Draft category selector: each entry is either an existing category id
 * or a new category name. Zero entries means "no categories".
 */
export type ItemCategoryDraft =
  | { kind: 'existing'; categoryId: number }
  | { kind: 'new'; category: NewCategoryInput };

/**
 * Draft input for the add/edit form: item name plus per-location stock
 * rows plus related-entity selectors. The repository validates the whole
 * draft, then creates the new locations/categories, the item, and its
 * stock rows in one exclusive transaction — any failure rolls back with
 * no orphan rows.
 */
export interface ItemDraftInput {
  name: string;
  /** Optional reminder level; null/absent means no reminder (U2). */
  lowStockThreshold?: number | null;
  /** Optional scanned identity; null/absent means no code (U2). */
  barcode?: string | null;
  stock?: ItemStockDraft[];
  categories?: ItemCategoryDraft[];
}

/** Impact of deleting a location, for the R3 confirmation copy. */
export interface LocationDeleteImpact {
  /** Stock rows that the delete removes (the DB cascades them). */
  stockRows: number;
  /** Items left with no stock anywhere afterwards (R6 sin stock). */
  unstockedItems: number;
}

/** Impact of deleting a category, for the R4 confirmation copy. */
export interface CategoryDeleteImpact {
  /** Items that lose this association (items themselves survive). */
  items: number;
}
