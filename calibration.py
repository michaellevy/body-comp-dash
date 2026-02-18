"""InBody calibration and body composition estimation.

Estimates muscle% from weight and fat% using a linear model trained on
historical data (old Google Sheet had a muscle column). Then calibrates
both fat% and muscle% using an affine transform fitted to two InBody scans.

Affine transform: calibrated = a * home_value + b
With 2 calibration points this is an exact solution, correcting both
scale bias (multiplicative) and offset bias (additive).
"""

import numpy as np
import pandas as pd
from models import get_model_coefficients, get_inbody_scans


def load_muscle_model():
    """Load the muscle% ~ weight + fat% linear model coefficients."""
    coefs = get_model_coefficients("muscle_percent")
    if coefs is None:
        raise ValueError(
            "No model coefficients found. Run migrate.py first to derive them."
        )
    return coefs["intercept"], coefs["weight_coef"], coefs["fat_coef"]


def estimate_muscle_percent(weight: np.ndarray, fat_percent: np.ndarray) -> np.ndarray:
    """Estimate muscle% from weight and fat% using the linear model."""
    intercept, w_coef, f_coef = load_muscle_model()
    return intercept + weight * w_coef + fat_percent * f_coef


def fit_affine_calibration():
    """Fit affine calibration transforms using InBody scan data.

    For each metric (fat%, muscle%), fits: calibrated = a * home + b
    using the two InBody calibration points.

    Returns dict with keys 'fat_percent' and 'muscle_percent', each
    containing (slope, intercept) tuple.
    """
    scans = get_inbody_scans()
    if len(scans) < 2:
        return None

    # Get home scale readings on InBody scan dates
    from models import get_db
    scan_dates = [s["date"] for s in scans]

    home_readings = []
    with get_db() as conn:
        for sd in scan_dates:
            row = conn.execute(
                "SELECT weight, fat_percent FROM measurements WHERE date = ?", (sd,)
            ).fetchone()
            if row:
                home_readings.append(dict(row))
            else:
                # Try nearest date within 2 days
                row = conn.execute(
                    """SELECT weight, fat_percent FROM measurements
                       WHERE date BETWEEN date(?, '-2 days') AND date(?, '+2 days')
                       ORDER BY ABS(julianday(date) - julianday(?)) LIMIT 1""",
                    (sd, sd, sd),
                ).fetchone()
                if row:
                    home_readings.append(dict(row))

    if len(home_readings) < 2:
        return None

    # Estimate home muscle% at each calibration point
    home_fat = np.array([r["fat_percent"] for r in home_readings])
    home_weight = np.array([r["weight"] for r in home_readings])
    home_muscle_pct = estimate_muscle_percent(home_weight, home_fat)

    # InBody values
    inbody_fat = np.array([s["fat_percent"] for s in scans[:2]])
    inbody_muscle_pct = np.array(
        [100 * s["muscle_mass"] / s["weight"] for s in scans[:2]]
    )

    # Fit affine: inbody = a * home + b (2 points => exact solution)
    def fit_affine(home_vals, inbody_vals):
        # [home1, 1] [a]   [inbody1]
        # [home2, 1] [b] = [inbody2]
        A = np.column_stack([home_vals, np.ones(2)])
        params = np.linalg.solve(A, inbody_vals)
        return params[0], params[1]  # slope, intercept

    fat_cal = fit_affine(home_fat, inbody_fat)
    muscle_cal = fit_affine(home_muscle_pct, inbody_muscle_pct)

    return {"fat_percent": fat_cal, "muscle_percent": muscle_cal}


def apply_calibration(df: pd.DataFrame) -> pd.DataFrame:
    """Apply full body composition pipeline to a measurements DataFrame.

    Input df must have columns: date, weight, fat_percent
    Output adds: muscle_percent, muscle_lbs, fat_lbs (all calibrated)
    """
    df = df.copy()
    mask = df["fat_percent"].notna()

    # Estimate raw muscle%
    df.loc[mask, "muscle_percent"] = estimate_muscle_percent(
        df.loc[mask, "weight"].values, df.loc[mask, "fat_percent"].values
    )

    # Apply InBody affine calibration
    cal = fit_affine_calibration()
    if cal:
        fat_slope, fat_intercept = cal["fat_percent"]
        muscle_slope, muscle_intercept = cal["muscle_percent"]

        df.loc[mask, "fat_percent"] = (
            fat_slope * df.loc[mask, "fat_percent"] + fat_intercept
        )
        df.loc[mask, "muscle_percent"] = (
            muscle_slope * df.loc[mask, "muscle_percent"] + muscle_intercept
        )

    # Calculate pounds
    df.loc[mask, "fat_lbs"] = df.loc[mask, "weight"] * df.loc[mask, "fat_percent"] / 100
    df.loc[mask, "muscle_lbs"] = df.loc[mask, "weight"] * df.loc[mask, "muscle_percent"] / 100

    return df
