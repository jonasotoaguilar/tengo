#!/usr/bin/env python3
"""Host SQLite verification for the Tengo v4 (catalog + stock) migration SQL.

Reads the REAL migration SQL from src/db/migrations.ts and executes it
against host SQLite (python3 sqlite3 module) to prove the rebuild mapping,
the preserve-and-stop guard, the FK-off envelope requirement, and the new
constraint behavior with a real engine.

This is HOST evidence only. It is NOT Expo/device proof: Jest fakes never
touch SQLite, this script never touches expo-sqlite or a device, and the
real native gate (v4 migration on a native emulator/device build) stays
pending. Do not cite this script as native verification.

Exit code is 0 only when every check passes.
"""

import re
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MIGRATIONS_TS = REPO / "src" / "db" / "migrations.ts"

PASS_COUNT = 0
FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS_COUNT
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    if condition:
        PASS_COUNT += 1
    else:
        FAILURES.append(name)


def extract_migration_sql(version: int) -> str:
    """Extract the MIGRATIONS[<version>] template literal from migrations.ts."""
    source = MIGRATIONS_TS.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^\s*{version}:\s*`(.*?)`\s*\.trim\(\)", re.MULTILINE | re.DOTALL
    )
    match = pattern.search(source)
    if not match:
        raise SystemExit(f"cannot extract MIGRATIONS[{version}] SQL")
    return match.group(1).strip()


def fresh_db() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.isolation_level = None  # autocommit; tests manage BEGIN/COMMIT
    return con


def tables(con: sqlite3.Connection) -> set[str]:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {row[0] for row in rows}


def expect_error(con: sqlite3.Connection, sql: str, params=()) -> str | None:
    """Run SQL expected to fail; return the error text, or None if it passed."""
    try:
        con.execute(sql, params)
    except sqlite3.Error as error:
        return str(error)
    return None


def apply_v3(con: sqlite3.Connection) -> None:
    """Bring a fresh DB to v3 (empty): the v4 starting point."""
    con.executescript(extract_migration_sql(1))
    con.executescript(extract_migration_sql(2))
    con.executescript(extract_migration_sql(3))
    con.execute("PRAGMA user_version = 3")


def apply_v4_envelope(con: sqlite3.Connection, v4_sql: str) -> None:
    """Apply v4 the way the runner does: FK OFF outside, rebuild + bump
    in one transaction with an empty foreign_key_check, then FK ON."""
    con.execute("PRAGMA foreign_keys = OFF")
    try:
        # One script: BEGIN + rebuild + version bump + COMMIT. (executescript
        # in autocommit mode commits any pending transaction first, so the
        # BEGIN/COMMIT must live inside the script itself.)
        con.executescript(f"BEGIN;\n{v4_sql}\nPRAGMA user_version = 4;\nCOMMIT;")
    except sqlite3.Error:
        try:
            con.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    violations = con.execute(
        "SELECT COUNT(*) FROM pragma_foreign_key_check"
    ).fetchone()[0]
    assert violations == 0, f"foreign_key_check: {violations}"
    con.execute("PRAGMA foreign_keys = ON")


def main() -> int:
    print(f"host sqlite version: {sqlite3.sqlite_version}")
    v4_sql = extract_migration_sql(4)
    check("extracted MIGRATIONS[4] SQL", "CREATE TABLE" in v4_sql.upper())
    check(
        "SCHEMA_VERSION is 5",
        re.search(r"export const SCHEMA_VERSION\s*=\s*5", MIGRATIONS_TS.read_text()) is not None,
    )

    # --- A. empty v3 migrates cleanly to v4 with the new shape -------------
    con = fresh_db()
    apply_v3(con)
    apply_v4_envelope(con, v4_sql)
    check(
        "empty v3 has all v4 tables",
        tables(con)
        == {"locations", "categories", "items", "item_categories", "stock"},
        str(sorted(tables(con))),
    )
    item_cols = [row[1] for row in con.execute("PRAGMA table_info(items)").fetchall()]
    check("catalog items holds id/name/created_at only", item_cols == ["id", "name", "created_at"], str(item_cols))
    stock_cols = [row[1] for row in con.execute("PRAGMA table_info(stock)").fetchall()]
    check(
        "stock holds item_id/location_id/quantity",
        stock_cols == ["item_id", "location_id", "quantity"],
        str(stock_cols),
    )
    stock_pk = con.execute("PRAGMA table_info(stock)").fetchall()
    check(
        "stock has the composite primary key",
        sorted(row[5] for row in stock_pk if row[5] > 0) == [1, 2],
        str(stock_pk),
    )
    fk_stock = con.execute("PRAGMA foreign_key_list(stock)").fetchall()
    check(
        "stock references items and locations, both CASCADE",
        {(row[2], row[6]) for row in fk_stock} == {("items", "CASCADE"), ("locations", "CASCADE")},
        str(fk_stock),
    )
    stock_ddl = con.execute("SELECT sql FROM sqlite_master WHERE name = 'stock'").fetchone()[0]
    check("stock DDL carries quantity > 0", "quantity > 0" in stock_ddl.lower())
    check("stock DDL carries the technical safe-integer bound", "9007199254740991" in stock_ddl)
    check("stock DDL has no RESTRICT", "RESTRICT" not in stock_ddl.upper())
    idx = con.execute("SELECT name FROM sqlite_master WHERE name = 'idx_stock_location_id'").fetchall()
    check("idx_stock_location_id exists", len(idx) == 1)
    check(
        "v4 user_version recorded",
        con.execute("PRAGMA user_version").fetchone()[0] == 4,
    )

    # --- B. populated v3 maps to catalog + stock, links preserved ---------
    con = fresh_db()
    con.execute("PRAGMA foreign_keys = ON")
    apply_v3(con)
    loc_a = con.execute("INSERT INTO locations (name) VALUES ('Casa')").lastrowid
    loc_b = con.execute("INSERT INTO locations (name) VALUES ('Garage')").lastrowid
    cat = con.execute("INSERT INTO categories (name) VALUES ('Grains')").lastrowid
    rice = con.execute(
        "INSERT INTO items (name, quantity, location_id) VALUES ('Rice', 2, ?)", (loc_a,)
    ).lastrowid
    beans = con.execute(
        "INSERT INTO items (name, quantity, location_id) VALUES ('Beans', 0, ?)", (loc_b,)
    ).lastrowid
    before_catalog = con.execute("SELECT id, name, created_at FROM items ORDER BY id").fetchall()
    before_sum = con.execute("SELECT COALESCE(SUM(quantity), 0) FROM items").fetchone()[0]
    con.execute("INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)", (rice, cat))
    con.execute("INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)", (beans, cat))
    apply_v4_envelope(con, v4_sql)
    check(
        "catalog keeps id/name/created_at byte-identical",
        con.execute("SELECT id, name, created_at FROM items ORDER BY id").fetchall() == before_catalog,
    )
    stock_rows = con.execute("SELECT item_id, location_id, quantity FROM stock").fetchall()
    check(
        "one stock row per old item with quantity > 0",
        stock_rows == [(rice, loc_a, 2)],
        str(stock_rows),
    )
    sin_stock = con.execute(
        "SELECT name FROM items i LEFT JOIN stock s ON s.item_id = i.id WHERE s.item_id IS NULL"
    ).fetchall()
    check("exhausted item is catalog-only (sin stock)", sin_stock == [("Beans",)], str(sin_stock))
    check(
        "stock sum equals the old quantity sum",
        con.execute("SELECT COALESCE(SUM(quantity), 0) FROM stock").fetchone()[0] == before_sum,
    )
    check(
        "category links survive the rebuild",
        con.execute("SELECT COUNT(*) FROM item_categories").fetchone()[0] == 2,
    )
    check(
        "foreign_key_check is empty after the rebuild",
        con.execute("SELECT COUNT(*) FROM pragma_foreign_key_check").fetchone()[0] == 0,
    )
    check(
        "autoincrement continues past the preserved max id",
        con.execute("INSERT INTO items (name) VALUES ('Salt')").lastrowid > max(rice, beans),
    )

    # --- C. the FK trap: DROP with keys ON destroys the category links ----
    con = fresh_db()
    con.execute("PRAGMA foreign_keys = ON")
    apply_v3(con)
    loc = con.execute("INSERT INTO locations (name) VALUES ('Casa')").lastrowid
    cat = con.execute("INSERT INTO categories (name) VALUES ('Grains')").lastrowid
    item = con.execute(
        "INSERT INTO items (name, quantity, location_id) VALUES ('Rice', 1, ?)", (loc,)
    ).lastrowid
    con.execute("INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)", (item, cat))
    con.executescript(f"BEGIN;\n{v4_sql}\nCOMMIT;")
    check(
        "DROP with FK ON cascades every category link (the trap)",
        con.execute("SELECT COUNT(*) FROM item_categories").fetchone()[0] == 0,
    )

    # --- D. guard SQL present and functional -------------------------------
    check("guard carries the typed v4 block", "Migration to schema version 4 blocked" in v4_sql)
    trigger = re.search(
        r"CREATE TEMP TRIGGER _migration_v4_guard_check.*?^END;",
        v4_sql,
        re.MULTILINE | re.DOTALL,
    )
    check("guard trigger text is extractable", trigger is not None)
    if trigger:
        # Catalog-count rig: items_new misses one row.
        rig = fresh_db()
        rig.executescript(
            """CREATE TABLE items (id INTEGER PRIMARY KEY, quantity INTEGER, location_id INTEGER);
               CREATE TABLE items_new (id INTEGER PRIMARY KEY);
               CREATE TABLE stock (item_id INTEGER, location_id INTEGER, quantity INTEGER);
               INSERT INTO items (id, quantity, location_id) VALUES (1, 2, 1), (2, 0, 1);
               INSERT INTO items_new (id) VALUES (1);"""
        )
        rig.executescript("CREATE TEMP TABLE _migration_v4_guard (id INTEGER);")
        rig.executescript(trigger.group(0))
        err = expect_error(rig, "INSERT INTO _migration_v4_guard (id) VALUES (1)")
        check("guard aborts on catalog count mismatch", err is not None and "Migration to schema version 4 blocked" in err, err or "")
        # Stock-sum rig: counts agree, sums differ.
        rig2 = fresh_db()
        rig2.executescript(
            """CREATE TABLE items (id INTEGER PRIMARY KEY, quantity INTEGER, location_id INTEGER);
               CREATE TABLE items_new (id INTEGER PRIMARY KEY);
               CREATE TABLE stock (item_id INTEGER, location_id INTEGER, quantity INTEGER);
               INSERT INTO items (id, quantity, location_id) VALUES (1, 2, 1);
               INSERT INTO items_new (id) VALUES (1);
               INSERT INTO stock (item_id, location_id, quantity) VALUES (1, 1, 5);"""
        )
        rig2.executescript("CREATE TEMP TABLE _migration_v4_guard (id INTEGER);")
        rig2.executescript(trigger.group(0))
        err2 = expect_error(rig2, "INSERT INTO _migration_v4_guard (id) VALUES (1)")
        check("guard aborts on stock sum mismatch", err2 is not None and "Migration to schema version 4 blocked" in err2, err2 or "")

    # --- E. v4 constraint behavior (FK pragma ON) ---------------------------
    con = fresh_db()
    con.execute("PRAGMA foreign_keys = ON")
    apply_v3(con)
    apply_v4_envelope(con, v4_sql)
    loc = con.execute("INSERT INTO locations (name) VALUES ('Casa')").lastrowid
    cat = con.execute("INSERT INTO categories (name) VALUES ('Grains')").lastrowid
    item = con.execute("INSERT INTO items (name) VALUES ('Rice')").lastrowid
    con.execute("INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 2)", (item, loc))
    con.execute("INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)", (item, cat))
    check("FK pragma reports enabled", con.execute("PRAGMA foreign_keys").fetchone()[0] == 1)
    check(
        "zero-quantity stock rejected (CHECK)",
        expect_error(con, "INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 0)", (item, loc)) is not None,
    )
    check(
        "duplicate stock row rejected (composite PK)",
        expect_error(con, "INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 2)", (item, loc)) is not None,
    )
    check(
        "absent item reference in stock rejected (FK)",
        expect_error(con, "INSERT INTO stock (item_id, location_id, quantity) VALUES (9999, ?, 1)", (loc,)) is not None,
    )
    check(
        "absent location reference in stock rejected (FK)",
        expect_error(con, "INSERT INTO stock (item_id, location_id, quantity) VALUES (?, 9999, 1)", (item,)) is not None,
    )
    check(
        "fractional quantity 1.5 rejected (integer storage)",
        expect_error(con, "INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 1.5)", (item, loc)) is not None,
    )
    check(
        "quantity above the technical bound rejected (CHECK)",
        expect_error(con, "INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 9007199254740992)", (item, loc)) is not None,
    )
    check(
        "location delete removes stock but never the item (R3)",
        expect_error(con, "DELETE FROM locations WHERE id = ?", (loc,)) is None
        and con.execute("SELECT COUNT(*) FROM stock").fetchone()[0] == 0
        and con.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 1,
    )
    check(
        "category links survive the location delete",
        con.execute("SELECT COUNT(*) FROM item_categories").fetchone()[0] == 1,
    )
    check(
        "deleting the item cleans its stock and join rows (CASCADE)",
        (con.execute("DELETE FROM items WHERE id = ?", (item,)).rowcount is not None)
        and con.execute("SELECT COUNT(*) FROM stock").fetchone()[0] == 0
        and con.execute("SELECT COUNT(*) FROM item_categories").fetchone()[0] == 0,
    )

    # --- F. atomic rollback: failed v4 keeps rows and version ---------------
    con = fresh_db()
    con.execute("PRAGMA foreign_keys = ON")
    apply_v3(con)
    loc = con.execute("INSERT INTO locations (name) VALUES ('Casa')").lastrowid
    con.execute("INSERT INTO items (name, quantity, location_id) VALUES ('Rice', 1, ?)", (loc,))
    con.execute("CREATE TABLE items_new (id INTEGER PRIMARY KEY, name TEXT);")
    blocked = False
    try:
        apply_v4_envelope(con, v4_sql)
    except sqlite3.Error:
        blocked = True
        try:
            con.execute("ROLLBACK;")
        except sqlite3.Error:
            pass
    check("blocked v4 raises instead of merging", blocked)
    check(
        "blocked v4 preserves rows and version",
        con.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 1
        and con.execute("PRAGMA user_version").fetchone()[0] == 3,
    )

    # --- G. v5 additive migration: threshold, barcode, expiry -------------
    v5_sql = extract_migration_sql(5)
    check("extracted MIGRATIONS[5] SQL", "ALTER TABLE" in v5_sql.upper())
    check(
        "v5 adds both item columns",
        "low_stock_threshold" in v5_sql and "barcode" in v5_sql,
    )
    check(
        "v5 creates the unique barcode index",
        "CREATE UNIQUE INDEX" in v5_sql.upper() and "idx_items_barcode" in v5_sql,
    )
    check("v5 adds the stock expiry column", "expires_on" in v5_sql)
    check(
        "v5 is additive: no rebuild, delete, or backfill",
        all(
            word not in v5_sql.upper()
            for word in ("CREATE TABLE", "DROP TABLE", "DELETE FROM", "INSERT INTO")
        ),
    )
    con = fresh_db()
    con.execute("PRAGMA foreign_keys = ON")
    apply_v3(con)
    apply_v4_envelope(con, v4_sql)
    before_items = con.execute("SELECT id, name, created_at FROM items ORDER BY id").fetchall()
    before_stock = con.execute("SELECT item_id, location_id, quantity FROM stock").fetchall()
    # Additive path: one transaction, FK pragma never toggled (only v4
    # owns the FK-off envelope).
    con.executescript(f"BEGIN;\n{v5_sql}\nPRAGMA user_version = 5;\nCOMMIT;")
    check(
        "v5 user_version recorded",
        con.execute("PRAGMA user_version").fetchone()[0] == 5,
    )
    check(
        "v5 preserves catalog and stock rows",
        con.execute("SELECT id, name, created_at FROM items ORDER BY id").fetchall() == before_items
        and con.execute("SELECT item_id, location_id, quantity FROM stock").fetchall() == before_stock,
    )
    item_cols = {row[1]: row for row in con.execute("PRAGMA table_info(items)").fetchall()}
    check(
        "items carries nullable threshold/barcode defaulting to NULL",
        item_cols["low_stock_threshold"][2].upper() == "INTEGER"
        and item_cols["barcode"][2].upper() == "TEXT"
        and item_cols["low_stock_threshold"][3] == 0
        and item_cols["barcode"][3] == 0
        and item_cols["low_stock_threshold"][4] is None
        and item_cols["barcode"][4] is None,
        str(sorted(item_cols)),
    )
    stock_cols = {row[1]: row for row in con.execute("PRAGMA table_info(stock)").fetchall()}
    check(
        "stock carries nullable expires_on defaulting to NULL",
        stock_cols["expires_on"][2].upper() == "TEXT"
        and stock_cols["expires_on"][3] == 0
        and stock_cols["expires_on"][4] is None,
        str(sorted(stock_cols)),
    )
    barcode_unique = con.execute(
        "SELECT `unique` FROM pragma_index_list('items') WHERE name = 'idx_items_barcode'"
    ).fetchone()
    check("idx_items_barcode is UNIQUE", barcode_unique is not None and barcode_unique[0] == 1)
    # NULL barcodes never collide: three codeless items stay legal.
    con.execute("INSERT INTO items (name) VALUES ('Rice')")
    con.execute("INSERT INTO items (name) VALUES ('Beans')")
    con.execute("INSERT INTO items (name) VALUES ('Salt')")
    check(
        "many items without a barcode stay legal",
        con.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 3,
    )
    con.execute("INSERT INTO items (name, barcode) VALUES ('Honey', '12345678')")
    check(
        "duplicate barcode rejected (UNIQUE)",
        expect_error(con, "INSERT INTO items (name, barcode) VALUES ('Oats', '12345678')") is not None,
    )
    rice = con.execute("SELECT id FROM items WHERE name = 'Rice'").fetchone()[0]
    con.execute("UPDATE items SET low_stock_threshold = 0 WHERE id = ?", (rice,))
    con.execute("UPDATE items SET low_stock_threshold = 999999 WHERE id = ?", (rice,))
    con.execute("UPDATE items SET low_stock_threshold = NULL WHERE id = ?", (rice,))
    check(
        "threshold CHECK: 0/999999/NULL pass",
        con.execute("SELECT low_stock_threshold FROM items WHERE id = ?", (rice,)).fetchone()[0] is None,
    )
    check(
        "threshold CHECK: -1/1000000/1.5 rejected",
        all(
            expect_error(con, "UPDATE items SET low_stock_threshold = ? WHERE id = ?", (bad, rice)) is not None
            for bad in (-1, 1000000, 1.5)
        ),
    )
    loc = con.execute("INSERT INTO locations (name) VALUES ('Casa')").lastrowid
    con.execute("INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 2)", (rice, loc))
    con.execute("UPDATE stock SET expires_on = '2027-03-15' WHERE item_id = ?", (rice,))
    con.execute("UPDATE stock SET expires_on = NULL WHERE item_id = ?", (rice,))
    check(
        "expires_on CHECK: ISO shape and NULL pass",
        con.execute("SELECT expires_on FROM stock WHERE item_id = ?", (rice,)).fetchone()[0] is None,
    )
    check(
        "expires_on CHECK: non-ISO text rejected",
        all(
            expect_error(con, "UPDATE stock SET expires_on = ? WHERE item_id = ?", (bad, rice)) is not None
            for bad in ("not-a-date", "15-03-2027", "2027-3-5")
        ),
    )
    check(
        "location delete still cascades stock, never items (R3 after v5)",
        expect_error(con, "DELETE FROM locations WHERE id = ?", (loc,)) is None
        and con.execute("SELECT COUNT(*) FROM stock").fetchone()[0] == 0
        and con.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 4,
    )

    print(f"\n{PASS_COUNT} checks passed, {len(FAILURES)} failed (host SQLite).")
    if FAILURES:
        print("failures:", FAILURES)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
