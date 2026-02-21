// Body composition calibration — ported from calibration.py
//
// Fat% correction: piecewise-linear by raw scale weight (not time).
// Using weight as the independent variable means the correction stays flat
// during maintenance/cardio phases and only extrapolates when weight actually
// changes — which is when the BIA error actually changes.
//
// All constants derived from muscle linear model + 3 gold-standard anchors:
//   2024-11-23  InBody       166.5 lbs  14.6% fat
//   2025-03-21  InBody       171.5 lbs  12.7% fat
//   2026-02-20  Hydrostatic  181.5 lbs  13.2% fat

// ── Muscle% linear model ──────────────────────────────────────────────────────
const MUSCLE_MODEL = {
    intercept:  48.85907224831961,
    weightCoef:  0.011898676042334806,
    fatCoef:    -0.5854039862344727,
};

// ── Weight correction (constant) ──────────────────────────────────────────────
// Median of (scale_weight − gold_weight) across the 3 calibration anchors.
const WEIGHT_BIAS = 1.3;

// ── Fat% bias anchor points ───────────────────────────────────────────────────
// [raw_scale_weight_lbs, bias_pp]  where bias = scale_fat% − gold_fat%
// Piecewise-linear interpolation between anchors; linear extrapolation beyond.
const FAT_BIAS_ANCHORS = [
    [167.8000, 4.0000],  // 2024-11-23 InBody
    [172.3470, 4.4028],  // 2025-03-21 InBody
    [183.0000, 7.1000],  // 2026-02-20 Hydrostatic
];

// ── Muscle% affine calibration ─────────────────────────────────────────────────
// Fitted to InBody anchor dates using corrected (not raw) scale values as inputs.
// inbody_muscle% = slope * model_muscle% + intercept
const MUSCLE_CAL = { slope: 1.1320982020, intercept: 0.8285357352 };

// ── Fat% bias interpolation ───────────────────────────────────────────────────
function fatBiasForWeight(rawWeight) {
    const pts = FAT_BIAS_ANCHORS;
    const n = pts.length;

    // Below lowest anchor: extrapolate along the first segment
    if (rawWeight <= pts[0][0]) {
        const slope = (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0]);
        return pts[0][1] + slope * (rawWeight - pts[0][0]);
    }
    // Above highest anchor: extrapolate along the last segment
    if (rawWeight >= pts[n - 1][0]) {
        const slope = (pts[n - 1][1] - pts[n - 2][1]) / (pts[n - 1][0] - pts[n - 2][0]);
        return pts[n - 1][1] + slope * (rawWeight - pts[n - 1][0]);
    }
    // Between anchors: piecewise-linear interpolation
    for (let i = 0; i < n - 1; i++) {
        if (rawWeight >= pts[i][0] && rawWeight <= pts[i + 1][0]) {
            const t = (rawWeight - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
            return pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
        }
    }
}

// ── Main calibration function ─────────────────────────────────────────────────
function calibrate(rows) {
    // Input:  [{date, weight, fat_percent}, ...]
    // Output: same rows with weight corrected and added fields:
    //         fat_percent_cal, muscle_percent, fat_lbs, muscle_lbs
    return rows.map(r => {
        const out = { ...r };
        if (r.fat_percent == null || r.weight == null) return out;

        // 1. Weight correction (constant offset)
        const corrWeight = r.weight - WEIGHT_BIAS;

        // 2. Fat% correction: piecewise-linear by raw scale weight
        const fatBias   = fatBiasForWeight(r.weight);
        const corrFat   = Math.min(Math.max(r.fat_percent - fatBias, 5), 35);

        // 3. Muscle% from linear model (corrected inputs) + affine calibration
        let musclePct = MUSCLE_MODEL.intercept
            + corrWeight * MUSCLE_MODEL.weightCoef
            + corrFat    * MUSCLE_MODEL.fatCoef;
        musclePct = MUSCLE_CAL.slope * musclePct + MUSCLE_CAL.intercept;

        out.weight          = corrWeight;   // charts show calibrated weight
        out.fat_percent_cal = corrFat;
        out.muscle_percent  = musclePct;
        out.fat_lbs         = corrWeight * corrFat    / 100;
        out.muscle_lbs      = corrWeight * musclePct  / 100;
        return out;
    });
}

window.calibrate = calibrate;
