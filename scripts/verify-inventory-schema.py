#!/usr/bin/env python3
"""Host SQLite verification for the Tengo M1 (schema v2) migration SQL.

Reads the REAL migration SQL from src/db/migrations.ts and executes it
against host SQLite (python3 sqlite3 module) to prove constraints,
foreign-key behavior, and rollback atomicity with a real engine.

This is HOST evidence only. It is NOT Expo/device proof: Jest fakes never
touch SQLite, this script never touches expo-sqlite or a device, and the
real native gate (v2 migration on a native emulator/device build) stays
pending before M2. Do not cite this script as native verification.

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


def main() -> int:
    print(f"host sqlite version: {sqlite3.sqlite_version}")
    v1_sql = extract_migration_sql(1)
    v2_sql = extract_migration_sql(2)
    check("extracted MIGRATIONS[1] SQL", "CREATE TABLE" in v1_sql.upper())
    check("extracted MIGRATIONS[2] SQL", "CREATE TABLE" in v2_sql.upper())

    # --- A. fresh database: v1 then v2 (empty) applies cleanly -------------
    con = fresh_db()
    con.executescript(v1_sql)
    con.execute("PRAGMA user_version = 1")
    con.executescript(v2_sql)
    con.execute("PRAGMA user_version = 2")
    check(
        "fresh DB has all v2 tables",
        tables(con) == {"locations", "categories", "items", "item_categories"},
        str(sorted(tables(con))),
    )
    fk_items = con.execute("PRAGMA foreign_key_list(items)").fetchall()
    check(
        "items.location_id references locations(id)",
        any(row[2] == "locations" and row[3] == "location_id" for row in fk_items),
        str(fk_items),
    )
    fk_join = con.execute("PRAGMA foreign_key_list(item_categories)").fetchall()
    check(
        "item_categories references items and categories",
        {row[2] for row in fk_join} == {"items", "categories"},
        str(fk_join),
    )
    join_pk = con.execute("PRAGMA table_info(item_categories)").fetchall()
    check(
        "item_categories has composite primary key",
        sorted(row[5] for row in join_pk if row[5] > 0) == [1, 2],
        str(join_pk),
    )
    items_ddl = con.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'items'"
    ).fetchone()[0]
    check("items DDL carries RESTRICT", "RESTRICT" in items_ddl.upper())
    check(
        "items DDL carries the technical safe-integer bound",
        "9007199254740991" in items_ddl,
    )
    check(
        "items DDL enforces integer storage (typeof quantity is integer)",
        "typeof(quantity)" in items_ddl.lower() and "'integer'" in items_ddl.lower(),
    )
    check(
        "items DDL has no CASCADE (location deletion never cascades items)",
        "CASCADE" not in items_ddl.upper(),
    )

    # --- B. populated v1 safe-stop: guard refuses, rows/version preserved --
    con = fresh_db()
    con.executescript(v1_sql)
    con.execute("PRAGMA user_version = 1")
    con.execute("INSERT INTO items (name) VALUES ('Rice')")
    count = con.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    ran_v2 = False
    if count == 0:  # mirrors the TypeScript guard in src/db/index.ts
        con.executescript(v2_sql)
        ran_v2 = True
    check("populated v1 blocks v2 (guard refuses)", count > 0 and not ran_v2)
    check(
        "populated v1 rows preserved",
        con.execute("SELECT name FROM items").fetchall() == [("Rice",)],
    )
    check(
        "populated v1 user_version preserved",
        con.execute("PRAGMA user_version").fetchone()[0] == 1,
    )

    # --- C. real constraint enforcement (FK pragma ON) ----------------------
    con = fresh_db()
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(v1_sql)
    con.executescript(v2_sql)
    loc = con.execute("INSERT INTO locations (name) VALUES ('Casa')").lastrowid
    cat = con.execute("INSERT INTO categories (name) VALUES ('Grains')").lastrowid
    check("FK pragma reports enabled", con.execute("PRAGMA foreign_keys").fetchone()[0] == 1)

    item = con.execute(
        "INSERT INTO items (name, quantity, location_id) VALUES ('Rice', 0, ?)",
        (loc,),
    ).lastrowid
    check("quantity zero inserts (exhausted)", item is not None)
    check(
        "NULL location_id rejected (NOT NULL)",
        expect_error(
            con, "INSERT INTO items (name, quantity) VALUES ('X', 1)"
        )
        is not None,
    )
    check(
        "absent location reference rejected (FK)",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('X', 1, 9999)",
        )
        is not None,
    )
    check(
        "absent item reference in join rejected (FK)",
        expect_error(
            con,
            "INSERT INTO item_categories (item_id, category_id) VALUES (9999, ?)",
            (cat,),
        )
        is not None,
    )
    check(
        "absent category reference in join rejected (FK)",
        expect_error(
            con,
            "INSERT INTO item_categories (item_id, category_id) VALUES (?, 9999)",
            (item,),
        )
        is not None,
    )
    con.execute(
        "INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)",
        (item, cat),
    )
    check(
        "duplicate category join rejected (composite PK)",
        expect_error(
            con,
            "INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)",
            (item, cat),
        )
        is not None,
    )
    check(
        "location with items cannot be deleted (RESTRICT, no orphan/cascade)",
        expect_error(con, "DELETE FROM locations WHERE id = ?", (loc,))
        is not None,
    )
    check(
        "location still present after blocked delete",
        con.execute("SELECT COUNT(*) FROM locations").fetchone()[0] == 1,
    )
    check(
        "negative quantity rejected (CHECK)",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('X', -1, ?)",
            (loc,),
        )
        is not None,
    )
    check(
        "quantity above the technical bound rejected (CHECK)",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('X', 9007199254740992, ?)",
            (loc,),
        )
        is not None,
    )
    check(
        "quantity at the technical bound inserts",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('Max', 9007199254740991, ?)",
            (loc,),
        )
        is None,
    )
    check(
        "fractional quantity 1.5 rejected by SQLite (integer storage)",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('Frac', 1.5, ?)",
            (loc,),
        )
        is not None,
    )
    con.execute("DELETE FROM items WHERE name IN ('Frac', 'TextBad', 'IntOk')")
    check(
        "non-numeric text quantity rejected by SQLite (integer storage)",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('TextBad', 'not-a-number', ?)",
            (loc,),
        )
        is not None,
    )
    con.execute("DELETE FROM items WHERE name IN ('Frac', 'TextBad', 'IntOk')")
    check(
        "positive integer quantity inserts",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('IntOk', 2, ?)",
            (loc,),
        )
        is None,
    )
    con.execute("DELETE FROM items WHERE name IN ('Frac', 'TextBad', 'IntOk', 'Max')")
    check(
        "blank item name rejected (CHECK length(TRIM(name)) > 0)",
        expect_error(
            con,
            "INSERT INTO items (name, quantity, location_id) VALUES ('   ', 1, ?)",
            (loc,),
        )
        is not None,
    )
    check(
        "blank location name rejected",
        expect_error(con, "INSERT INTO locations (name) VALUES ('  ')") is not None,
    )
    check(
        "empty-string address rejected (must be NULL, not '')",
        expect_error(con, "INSERT INTO locations (name, address) VALUES ('B', '')")
        is not None,
    )
    check(
        "NULL address inserts (optional address)",
        expect_error(con, "INSERT INTO locations (name, address) VALUES ('B2', NULL)")
        is None,
    )
    con.execute("DELETE FROM items WHERE id = ?", (item,))
    check(
        "deleting an item cleans up its join rows (CASCADE on join)",
        con.execute("SELECT COUNT(*) FROM item_categories").fetchone()[0] == 0,
    )

    # --- D. atomic rollback: failed v2 leaves no tables and keeps version ---
    con = fresh_db()
    con.executescript(v1_sql)
    con.execute("PRAGMA user_version = 1")
    statements = [s.strip() for s in v2_sql.split(";") if s.strip()]
    con.execute("BEGIN")
    try:
        for statement in statements:
            con.execute(statement)
        con.execute("THIS IS NOT VALID SQL")
        con.execute("COMMIT")
    except sqlite3.Error:
        con.execute("ROLLBACK")
    check(
        "rolled-back v2 leaves no v2 tables",
        tables(con) == {"items"},
        str(sorted(tables(con))),
    )
    check(
        "rolled-back v2 keeps user_version 1",
        con.execute("PRAGMA user_version").fetchone()[0] == 1,
    )

    # --- E. user_version is transactional (validates the bump-inside-txn design)
    con = fresh_db()
    con.execute("PRAGMA user_version = 1")
    con.execute("BEGIN")
    con.execute("PRAGMA user_version = 2")
    con.execute("ROLLBACK")
    reverted = con.execute("PRAGMA user_version").fetchone()[0]
    check("PRAGMA user_version rolls back with the transaction", reverted == 1,
          f"after ROLLBACK user_version={reverted}")

    print(f"\n{PASS_COUNT} checks passed, {len(FAILURES)} failed (host SQLite).")
    if FAILURES:
        print("failures:", FAILURES)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
