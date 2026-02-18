"""One-time migration script: CSV files -> SQLite.

Imports historical data from CSV exports, derives muscle% model
coefficients from the old sheet data, and seeds InBody scans + events.

Usage:
    python migrate.py
"""

import os
import numpy as np
import pandas as pd
from datetime import date

import models

BASE_DIR = os.path.dirname(__file__)
WEIGHT_FAT_CSV = os.path.join(BASE_DIR, "weight_fat.csv")
MUSCLE_DATA_CSV = os.path.join(BASE_DIR, "muscle_data.csv")


def load_measurements():
    """Load the combined weight/fat CSV (already merged from both sheets)."""
    print(f"Loading {WEIGHT_FAT_CSV}...")
    df = pd.read_csv(WEIGHT_FAT_CSV)
    df["date"] = pd.to_datetime(df["date"]).dt.date

    # Clean NA strings
    for col in ["weight", "fat_percent"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["weight"])
    print(f"  {len(df)} rows loaded")
    return df


def load_muscle_data():
    """Load the old sheet with muscle% column for model fitting."""
    print(f"Loading {MUSCLE_DATA_CSV}...")
    df = pd.read_csv(MUSCLE_DATA_CSV)
    df["date"] = pd.to_datetime(df["date"], format="%m/%d/%Y").dt.date

    # Rename to standard columns
    df = df.rename(columns={"new_scale": "weight", "body_fat": "fat_percent"})

    for col in ["weight", "fat_percent", "muscle"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["weight"])
    print(f"  {len(df)} rows loaded")
    return df


def derive_muscle_model(muscle_df):
    """Fit muscle_percent ~ weight + fat_percent linear model.

    The 'muscle' column in the old sheet is already muscle% (values ~39-42).
    """
    print("Deriving muscle% model coefficients...")
    df = muscle_df.dropna(subset=["weight", "fat_percent", "muscle"]).copy()
    if len(df) < 3:
        print(f"  Warning: Only {len(df)} complete rows for model fitting.")
        return None

    # muscle column is already muscle% (values ~39-42)
    X = np.column_stack([np.ones(len(df)), df["weight"].values, df["fat_percent"].values])
    y = df["muscle"].values
    coefs, _, _, _ = np.linalg.lstsq(X, y, rcond=None)

    intercept, weight_coef, fat_coef = coefs
    print(f"  Intercept: {intercept:.6f}")
    print(f"  Weight coef: {weight_coef:.6f}")
    print(f"  Fat% coef: {fat_coef:.6f}")
    print(f"  R² check: predicts {intercept + 170 * weight_coef + 18 * fat_coef:.1f}% muscle for 170 lbs / 18% fat")

    return intercept, weight_coef, fat_coef


def seed_inbody_scans():
    print("Seeding InBody scans...")
    models.add_inbody_scan(date(2024, 11, 23), weight=166.5, fat_percent=14.6, muscle_mass=81.1)
    models.add_inbody_scan(date(2025, 3, 21), weight=171.5, fat_percent=12.7, muscle_mass=85.8)


def seed_events():
    print("Seeding events...")
    models.add_event(date(2024, 11, 11), "Started CrossFit")
    models.add_event(date(2025, 3, 31), "Started Strength Training")


def main():
    # Remove old DB if re-running
    if os.path.exists(models.DB_PATH):
        print(f"Removing existing database: {models.DB_PATH}")
        os.remove(models.DB_PATH)

    models.init_db()

    # Load data
    measurements_df = load_measurements()
    muscle_df = load_muscle_data()

    # Derive and save model coefficients
    coefs = derive_muscle_model(muscle_df)
    if coefs:
        models.save_model_coefficients("muscle_percent", *coefs)
        print("Model coefficients saved to DB.")

    # Insert measurements
    rows = [
        {
            "date": r["date"].isoformat(),
            "weight": r["weight"],
            "fat_percent": r["fat_percent"] if pd.notna(r["fat_percent"]) else None,
            "source": "csv_import",
        }
        for _, r in measurements_df.iterrows()
    ]
    print(f"Inserting {len(rows)} measurements...")
    models.bulk_insert_measurements(rows)

    seed_inbody_scans()
    seed_events()

    # Summary
    all_m = models.get_measurements()
    print(f"\nMigration complete! {len(all_m)} total measurements in database.")
    if all_m:
        print(f"Date range: {all_m[0]['date']} to {all_m[-1]['date']}")

    # Verify calibration works
    from calibration import apply_calibration
    sample = pd.DataFrame(all_m[-5:])
    sample["date"] = pd.to_datetime(sample["date"])
    calibrated = apply_calibration(sample)
    print("\nLast 5 entries (calibrated):")
    for _, r in calibrated.iterrows():
        muscle_str = f"{r['muscle_lbs']:.1f}" if pd.notna(r.get("muscle_lbs")) else "—"
        fat_str = f"{r['fat_lbs']:.1f}" if pd.notna(r.get("fat_lbs")) else "—"
        print(f"  {r['date'].date()}: {r['weight']:.1f} lbs, fat={fat_str} lbs, muscle={muscle_str} lbs")


if __name__ == "__main__":
    main()
