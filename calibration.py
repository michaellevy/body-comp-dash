"""Body composition calibration using gold-standard scans.

Fat% correction — weight-varying piecewise-linear bias removal
--------------------------------------------------------------
The home BIA scale systematically over-estimates fat% in muscular
individuals, and this bias grows as lean mass increases (the BIA
algorithm interprets lower impedance as "more fat" rather than "more
muscle").  We correct for this with a bias function fitted to all
gold-standard measurements (InBody + hydrostatic), using raw scale
weight as the independent variable rather than time.

    corrected_fat% = scale_fat% − bias(scale_weight)

Using weight (a proxy for LBM) rather than time means the correction
stays flat during weight-stable phases (maintenance, cardio season)
and only extrapolates when weight actually changes — which is when
the BIA error is actually changing.

Weight correction — constant additive offset
--------------------------------------------
    corrected_weight = scale_weight − weight_bias

where weight_bias is the median of (scale_weight − gold_weight) across
all anchor dates.

Muscle% — linear model + affine calibration
-------------------------------------------
Muscle% is estimated from corrected weight and fat% via a linear model
trained on historical data, then corrected with a 2-point affine
transform fitted to InBody scans (which directly measure skeletal
muscle mass).  Hydrostatic scans are excluded from this step because
they do not report muscle mass independently.
"""

import math
import numpy as np
import pandas as pd
from scipy.interpolate import interp1d

from models import get_model_coefficients, get_inbody_scans, get_db


# ── Muscle linear model ──────────────────────────────────────────────────────

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


# ── Calibration anchor computation ──────────────────────────────────────────

def _get_anchor_points() -> list[dict]:
    """For each gold-standard scan, find the proximity-weighted mean scale
    reading within ±7 days (exponential decay, half-life = 3 days).

    Returns list of dicts sorted by date, each with:
        date, source, gold_weight, gold_fat_pct, gold_muscle_mass,
        scale_weight, scale_fat_pct
    """
    scans = get_inbody_scans()
    anchors = []

    with get_db() as conn:
        for scan in scans:
            sd = scan["date"]
            rows = conn.execute(
                """SELECT date, weight, fat_percent FROM measurements
                   WHERE date BETWEEN date(?, '-7 days') AND date(?, '+7 days')
                     AND fat_percent IS NOT NULL
                   ORDER BY ABS(julianday(date) - julianday(?))""",
                (sd, sd, sd),
            ).fetchall()

            if not rows:
                continue

            rows = [dict(r) for r in rows]
            days_away = [
                abs((pd.Timestamp(r["date"]) - pd.Timestamp(sd)).days)
                for r in rows
            ]
            weights = [math.exp(-d / 3.0) for d in days_away]
            total = sum(weights)
            sw = sum(r["weight"]      * w for r, w in zip(rows, weights)) / total
            sf = sum(r["fat_percent"] * w for r, w in zip(rows, weights)) / total

            anchors.append({
                "date":             pd.Timestamp(sd),
                "source":           scan.get("source", "inbody"),
                "gold_weight":      scan["weight"],
                "gold_fat_pct":     scan["fat_percent"],
                "gold_muscle_mass": scan.get("muscle_mass"),
                "scale_weight":     sw,
                "scale_fat_pct":    sf,
            })

    return sorted(anchors, key=lambda a: a["date"])


# ── Bias correction builders ─────────────────────────────────────────────────

def _build_fat_pct_corrector(anchors: list[dict]):
    """Return a vectorised function  raw_scale_weight -> fat% bias array.

    Bias is defined as (scale_fat% − gold_fat%) at each anchor and is
    modelled as a function of raw scale weight rather than time.

    Rationale: the BIA over-estimate grows because lean mass increases,
    not because the calendar advances.  Using scale weight as the predictor
    means the correction stays flat when weight is stable (e.g. a maintenance
    or cardio-focus phase) and only extrapolates when weight actually changes.

    Between anchors: piecewise-linear interpolation.
    Beyond anchors: linear extrapolation along the adjacent segment.
    """
    if not anchors:
        return lambda weights: np.zeros(len(weights))

    w    = np.array([a["scale_weight"] for a in anchors], dtype=np.float64)
    bias = np.array([a["scale_fat_pct"] - a["gold_fat_pct"] for a in anchors])

    # Sort by weight (should already be monotone given the gain trajectory,
    # but guard against edge cases)
    order = np.argsort(w)
    w, bias = w[order], bias[order]

    if len(anchors) == 1:
        b0 = bias[0]
        return lambda weights: np.full(len(weights), b0)

    fn = interp1d(w, bias, kind="linear", fill_value="extrapolate")

    def corrector(weights):
        return fn(np.asarray(weights, dtype=np.float64))

    return corrector


def _fit_muscle_affine(anchors: list[dict], weight_bias: float, fat_corrector):
    """Fit affine  inbody_muscle% = slope * model_muscle% + intercept
    using only InBody anchors that have a measured muscle_mass.

    Uses *corrected* scale values as model inputs so the affine is
    consistent with what apply_calibration actually feeds the model.

    Falls back to None (identity) if fewer than 2 such anchors exist.
    """
    inbody = [
        a for a in anchors
        if a["source"] == "inbody" and a["gold_muscle_mass"] is not None
    ]
    if len(inbody) < 2:
        return None

    home_muscle, gold_muscle = [], []
    for a in inbody:
        # Apply the same corrections that apply_calibration will use.
        # fat_corrector now takes raw scale weight (not dates).
        corr_weight = a["scale_weight"] - weight_bias
        corr_fat    = float(np.clip(
            a["scale_fat_pct"] - fat_corrector([a["scale_weight"]])[0], 5, 35
        ))
        model_pct = float(
            estimate_muscle_percent(
                np.array([corr_weight]),
                np.array([corr_fat]),
            )[0]
        )
        inbody_pct = 100.0 * a["gold_muscle_mass"] / a["gold_weight"]
        home_muscle.append(model_pct)
        gold_muscle.append(inbody_pct)

    home = np.array(home_muscle)
    gold = np.array(gold_muscle)
    A = np.column_stack([home, np.ones(len(home))])
    params, _, _, _ = np.linalg.lstsq(A, gold, rcond=None)
    return float(params[0]), float(params[1])  # slope, intercept


# ── Public API ───────────────────────────────────────────────────────────────

def apply_calibration(df: pd.DataFrame) -> pd.DataFrame:
    """Apply full body composition pipeline to a measurements DataFrame.

    Input  columns:  date, weight, fat_percent
    Output columns:  (all of the above, corrected) + fat_lbs, muscle_lbs
    """
    df = df.copy()
    mask = df["fat_percent"].notna()

    anchors = _get_anchor_points()

    # ── Weight correction (constant) ─────────────────────────────────────────
    if anchors:
        weight_bias = float(np.median(
            [a["scale_weight"] - a["gold_weight"] for a in anchors]
        ))
    else:
        weight_bias = 0.0

    df["weight"] = df["weight"] - weight_bias

    # ── Fat% correction (weight-varying) ─────────────────────────────────────
    # Pass the *raw* (pre-correction) weight so the corrector operates on the
    # same scale as the anchor scale_weight values it was fitted against.
    if mask.any():
        corrector = _build_fat_pct_corrector(anchors)
        raw_weight = df.loc[mask, "weight"] + weight_bias  # undo weight correction
        df.loc[mask, "fat_percent"] = (
            df.loc[mask, "fat_percent"] - corrector(raw_weight.values)
        ).clip(5, 35)

    # ── Muscle% estimation + affine calibration ───────────────────────────────
    if mask.any():
        muscle_pct = estimate_muscle_percent(
            df.loc[mask, "weight"].values,
            df.loc[mask, "fat_percent"].values,
        )
        muscle_affine = _fit_muscle_affine(anchors, weight_bias, corrector)
        if muscle_affine:
            slope, intercept = muscle_affine
            muscle_pct = slope * muscle_pct + intercept
        df.loc[mask, "muscle_percent"] = muscle_pct

    # ── Derived pounds ────────────────────────────────────────────────────────
    df.loc[mask, "fat_lbs"]    = df.loc[mask, "weight"] * df.loc[mask, "fat_percent"]    / 100
    df.loc[mask, "muscle_lbs"] = df.loc[mask, "weight"] * df.loc[mask, "muscle_percent"] / 100

    return df
