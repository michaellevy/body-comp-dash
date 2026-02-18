"""Database schema and data access layer for body composition dashboard."""

import sqlite3
import os
from datetime import datetime, date
from contextlib import contextmanager

DB_PATH = os.environ.get("BODY_COMP_DB", os.path.join(os.path.dirname(__file__), "body_comp.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL,
    weight REAL NOT NULL,
    fat_percent REAL,
    source TEXT DEFAULT 'app',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inbody_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL,
    weight REAL,
    fat_percent REAL,
    muscle_mass REAL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL,
    label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_coefficients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    intercept REAL NOT NULL,
    weight_coef REAL NOT NULL,
    fat_coef REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_measurements_date ON measurements(date);
"""


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)


def add_measurement(dt: date, weight: float, fat_percent: float = None, source: str = "app"):
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO measurements (date, weight, fat_percent, source) VALUES (?, ?, ?, ?)",
            (dt.isoformat(), weight, fat_percent, source),
        )


def get_measurements(since: date = None):
    with get_db() as conn:
        if since:
            rows = conn.execute(
                "SELECT * FROM measurements WHERE date >= ? ORDER BY date", (since.isoformat(),)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM measurements ORDER BY date").fetchall()
    return [dict(r) for r in rows]


def get_recent_measurements(n: int = 5):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM measurements ORDER BY date DESC LIMIT ?", (n,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_inbody_scans():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM inbody_scans ORDER BY date").fetchall()
    return [dict(r) for r in rows]


def add_inbody_scan(dt: date, weight: float, fat_percent: float, muscle_mass: float):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO inbody_scans (date, weight, fat_percent, muscle_mass) VALUES (?, ?, ?, ?)",
            (dt.isoformat(), weight, fat_percent, muscle_mass),
        )


def get_events():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM events ORDER BY date").fetchall()
    return [dict(r) for r in rows]


def add_event(dt: date, label: str):
    with get_db() as conn:
        conn.execute("INSERT INTO events (date, label) VALUES (?, ?)", (dt.isoformat(), label))


def get_model_coefficients(name: str = "muscle_percent"):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM model_coefficients WHERE name = ?", (name,)
        ).fetchone()
    return dict(row) if row else None


def save_model_coefficients(name: str, intercept: float, weight_coef: float, fat_coef: float):
    with get_db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO model_coefficients (name, intercept, weight_coef, fat_coef)
               VALUES (?, ?, ?, ?)""",
            (name, intercept, weight_coef, fat_coef),
        )


def bulk_insert_measurements(rows: list[dict]):
    with get_db() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO measurements (date, weight, fat_percent, source) VALUES (:date, :weight, :fat_percent, :source)",
            rows,
        )
