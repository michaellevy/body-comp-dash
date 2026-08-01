// Body composition calibration against gold-standard scans.
//
// Fat% correction: a bias removed in SCALE-LEAN-MASS space, not against gross
// weight, with the InBody↔hydrostatic method difference held as its own term so
// it can't masquerade as a trend.
//
// Gold-standard anchors:
//   2024-11-23  InBody       166.5 lbs  14.6% fat  81.1 lbs muscle
//   2025-03-21  InBody       171.5 lbs  12.7% fat  85.8 lbs muscle
//   2026-02-20  Hydrostatic  181.5 lbs  13.2% fat  (no muscle mass reported)
//
// ── Why lean mass and not weight ──────────────────────────────────────────────
// The bias exists because BIA misreads a muscular body, so it should track lean
// mass. Keying it to gross weight instead means a pure FAT gain raises the
// correction — the model tells you you're leaner than the scale says precisely
// because you got heavier. Scale-lean (weight × (1 − fat%/100)) barely moves
// during a fat gain, so the correction stays put.
//
// ── Why the bias is nearly flat ───────────────────────────────────────────────
// The two InBody anchors — the only same-device pair — put the slope at
// 0.067 pp per lb of scale-lean with a standard error of ~0.10 (t = 0.66). That
// is indistinguishable from zero, so BETA is that estimate shrunk by t²/(1+t²).
// The apparent steep trend in the earlier version came from fitting a straight
// line through anchors taken on two DIFFERENT instruments: hydrostatic reads
// ~2.2 pp leaner than the InBody trend predicts, and attributing that method
// offset to weight produced a slope 5× the within-device one — which, projected
// past 183 lbs, reported FAT LOSS during weight gain at an unchanged scale
// reading, and FFMI above the natural ceiling by 190 lbs.
//
// Level is anchored on the hydrostatic scan (chosen reference: underwater
// weighing is densitometry, while InBody is itself a BIA device). Consequence
// worth knowing: every reading sits ~2.2 pp leaner than an InBody-anchored fit
// would place it, including the whole pre-2024 history.

// ── Weight correction (constant) ──────────────────────────────────────────────
// Median of (scale − gold) using each scan's SAME-DAY home reading. Both sides
// are single-day snapshots carrying the same hydration state, so pairing them
// directly is right here; smoothing one side and not the other mixes trend into
// a same-day comparison and scatters the estimate (1.3/0.9/1.5 → 2.4/0.9/1.2).
const WEIGHT_BIAS = 1.30;

// ── Fat% bias model ───────────────────────────────────────────────────────────
// bias(L) = BIAS_REF + BETA · (L − LM_REF),  L = scale-implied lean mass.
//
// Anchor scale values are Gaussian kernel means (σ = 14 d) rather than the
// nearest single reading. A lone BIA reading carries ~0.80 pp of noise — measured
// over 1120 readings — and the old ±7-day weighting pooled an effective 1.0–1.2
// readings, so it removed none of it. Fat% is a slow-moving quantity under fast
// noise, so averaging is the right estimator; σ = 14 d pools ~4 readings without
// reaching far enough to import a trend. It moved the 2026 anchor by −0.79 pp.
const BIAS_REF = 6.3124;    // pp, at the hydrostatic anchor
const LM_REF   = 147.0079;  // lbs of scale-lean at that anchor
const BETA     = 0.02012;   // pp per lb of scale-lean (shrunk from 0.06689)

// Scale-lean actually spanned by the anchors. Outside it the slope is untested,
// so it decays instead of running: the bias may drift at most BETA · LM_TAPER
// (≈0.30 pp) beyond either end, then flattens. Extrapolating a fitted slope past
// its own data is what broke the previous version.
const LM_LO = 137.81, LM_HI = 147.01;
const LM_TAPER = 15;        // lbs — e-folding distance of the slope decay

// ── Muscle mass ───────────────────────────────────────────────────────────────
// Skeletal muscle as a fraction of lean mass, straight from the two InBody scans
// that report it: 0.5704 and 0.5731. That agreement across 7.5 lbs of lean gain
// is the whole justification — one constant reproduces both scans to within
// 0.2 lbs.
//
// This replaces a regression of muscle% on weight and fat%, refit by a 2-point
// affine transform. That construction had zero residual degrees of freedom (two
// points, two parameters) and amplified the fat% error by 13% on its way through.
// Both versions agree at the anchors; only this one stays bounded off them.
//
// The ratio is taken from InBody rather than its absolute muscle number on
// purpose: both come from the same impedance measurement, so dividing cancels
// much of the device error that the fat% correction exists to undo. The
// consequence is that predicted muscle sits ~1.7–3.0 lbs ABOVE the figure InBody
// printed, by the same proportion that hydrostatic-anchored lean sits above
// InBody's lean. That is the hydrostatic reference propagating through, not drift.
//
// Note what it does NOT do: muscle is a fixed fraction of lean, which is a fixed
// function of weight and fat%. The muscle series carries no information the fat
// series doesn't — as was also true before. Independent muscle tracking needs
// the tape sites, not another transform of the same two numbers.
const MUSCLE_OF_LEAN = 0.57172;

// ── Physiological guards ──────────────────────────────────────────────────────
// Both are backstops, not fitted behaviour: neither binds on any reading in the
// current history (which spans 7.2–15.2% fat and FFMI 20.2–23.8). They exist so
// that a future recalibration against a bad or mismatched anchor degrades
// visibly rather than silently. The FFMI ceiling first bites around 200 lbs raw
// at a 19% scale reading; if the dashboard ever flattens lean mass there, that
// is the model asking for a fresh scan, not a real plateau.
const FFMI_CAP = 25.5;      // drug-free fat-free mass index ceiling, plus headroom
const FAT_MIN = 5, FAT_MAX = 35;

// Largest slope that keeps the correction physically coherent. Above it, adding
// weight at an unchanged scale fat% would be reported as LOSING fat mass:
//
//   fat_lbs = (W − WEIGHT_BIAS)·(F − bias)/100,  d(bias)/dW = beta·(1 − F/100)
//   d(fat_lbs)/dW ≥ 0  ⟺  beta ≤ (F − bias) / [(W − WEIGHT_BIAS)·(1 − F/100)]
//
// BIAS_REF stands in for bias to keep this non-circular; the taper holds the two
// within ~0.3 pp everywhere, far below the ~4× margin the cap currently has.
function coherentSlopeCap(rawWeight, rawFat) {
    return (rawFat - BIAS_REF) / ((rawWeight - WEIGHT_BIAS) * (1 - rawFat / 100));
}

function fatBiasForLean(leanScale, rawWeight, rawFat) {
    const beta = Math.min(BETA, coherentSlopeCap(rawWeight, rawFat));

    // Inside the anchored span the slope applies in full. Outside, the excess
    // enters through 1 − e^(−d/τ), which matches the linear slope at the
    // boundary and asymptotes — continuous in both value and derivative, so no
    // kink appears where the two regimes meet.
    const clamped = Math.min(Math.max(leanScale, LM_LO), LM_HI);
    const excess = leanScale - clamped;
    const tapered = Math.sign(excess) * LM_TAPER * (1 - Math.exp(-Math.abs(excess) / LM_TAPER));

    return BIAS_REF + beta * ((clamped - LM_REF) + tapered);
}

// Lean mass implied by FFMI_CAP at the recorded height, or null if height is
// unavailable. Defaults inside db.getHeight() keep this from ever being the
// reason a reading fails to render.
function leanCeiling(corrWeight) {
    const heightIn = (window.db && db.getHeight) ? db.getHeight() : null;
    if (!heightIn) return null;
    const hM = heightIn * 0.0254;
    return (FFMI_CAP * hM * hM) / 0.45359237;   // kg/m² → lbs
}

// ── Main calibration function ─────────────────────────────────────────────────
function calibrate(rows) {
    // Input:  [{date, weight, fat_percent}, ...]
    // Output: same rows, weight corrected, plus:
    //         fat_percent_cal, muscle_percent, fat_lbs, muscle_lbs, lean_lbs,
    //         extrapolation_lbs — how far outside the anchored lean span this
    //         reading sits, for charts that want to mark unsupported territory.
    return rows.map(r => {
        const out = { ...r };
        if (r.fat_percent == null || r.weight == null) return out;

        // 1. Weight correction (constant offset)
        const corrWeight = r.weight - WEIGHT_BIAS;

        // 2. Fat% correction, keyed to the scale's own lean estimate
        const leanScale = r.weight * (1 - r.fat_percent / 100);
        const bias = fatBiasForLean(leanScale, r.weight, r.fat_percent);
        let corrFat = Math.min(Math.max(r.fat_percent - bias, FAT_MIN), FAT_MAX);

        // 3. Guard: never imply a physically impossible amount of lean mass
        const ceiling = leanCeiling(corrWeight);
        if (ceiling != null && corrWeight * (1 - corrFat / 100) > ceiling) {
            corrFat = Math.min(Math.max(100 * (1 - ceiling / corrWeight), FAT_MIN), FAT_MAX);
        }

        const leanLbs = corrWeight * (1 - corrFat / 100);

        out.weight            = corrWeight;   // charts show calibrated weight
        out.fat_percent_cal   = corrFat;
        out.lean_lbs          = leanLbs;
        out.fat_lbs           = corrWeight * corrFat / 100;
        out.muscle_lbs        = MUSCLE_OF_LEAN * leanLbs;
        out.muscle_percent    = 100 * out.muscle_lbs / corrWeight;
        out.extrapolation_lbs = leanScale < LM_LO ? LM_LO - leanScale
                              : leanScale > LM_HI ? leanScale - LM_HI : 0;
        return out;
    });
}

window.calibrate = calibrate;
