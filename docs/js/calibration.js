// Body composition calibration against gold-standard scans.
//
// Fat% correction: a bias removed in SCALE-LEAN-MASS space, not against gross
// weight, with the BIA↔densitometry method difference held as its own term so
// it can't masquerade as a trend.
//
// Gold-standard anchors                                    method family  fasted
//   2015-05-15  Skinfold JP7  161.8 lbs   9.7% fat  —         densitometry  ?
//   2024-11-23  InBody        166.5 lbs  14.6% fat  81.1 lbs  BIA           yes
//   2025-03-21  InBody        171.5 lbs  12.7% fat  85.8 lbs  BIA           yes
//   2026-02-20  Hydrostatic   181.5 lbs  13.2% fat  —         densitometry  NO
//
// ── The 2015 anchor ───────────────────────────────────────────────────────────
// Added last, and it is the only anchor that was never fitted to: the model as
// calibrated on the 2024–2026 scans alone predicted 9.73% fat for that date, and
// the sheet prints 9.7%. Eleven years and 20 lbs of scale-lean out of sample.
// Treat that as a passed falsification test, not as precision — JP7's standard
// error against hydrostatic is ~3.5 pp, so agreeing to 0.03 pp is better than
// the method deserves and partly luck.
//
// Its real work is structural, in two places:
//
//   1. It corroborates the level. Skinfold-JP7 is densitometry (Jackson–Pollock
//      predicts body density, Siri converts it), the same 2C family as underwater
//      weighing — NOT a second BIA device. It lands with hydrostatic and 2.2 pp
//      away from InBody. Until this anchor existed, anchoring level on
//      hydrostatic rested on an a-priori argument about which instrument to
//      trust; now two independent densitometry measurements 11 years apart agree
//      on it, and the InBody offset below is fitted rather than asserted.
//
//   2. It extends the anchored lean span DOWNWARD, which is what actually moves
//      the dashboard. 73% of the reading history sat below the old LM_LO and ran
//      on the taper; at LM_LO = 135.85 that falls to 46%. Half the pre-2020
//      chart stops being extrapolation. The coefficient changes themselves are
//      invisible — every reading in the history moves by 0.05–0.08 pp.
//
// Ironman-era training is not a confound. The bias is a property of the DEVICE
// reading a body, keyed to scale-lean precisely so that training state drops
// out; a point at 135.9 lbs of scale-lean in peak triathlon shape against one at
// 147.0 lbs now is the exact contrast the model has to survive to be worth
// anything.
//
// ── Why lean mass and not weight ──────────────────────────────────────────────
// The bias exists because BIA misreads a muscular body, so it should track lean
// mass. Keying it to gross weight instead means a pure FAT gain raises the
// correction — the model tells you you're leaner than the scale says precisely
// because you got heavier. Scale-lean (weight × (1 − fat%/100)) barely moves
// during a fat gain, so the correction stays put.
//
// ── How the coefficients are fitted ───────────────────────────────────────────
// One joint least-squares fit over all four anchors:
//
//   bias = BIAS_REF + BETA · (L − LM_REF) + IB_METHOD_OFFSET · 1{InBody}
//
// Three parameters, four anchors — the first version of this model with any
// residual degree of freedom at all, so the fit can finally be wrong in a way
// that shows. Residuals are ±0.11 pp (RMS 0.17), and the level term carries a
// standard error of 0.16 pp.
//
// Level is anchored on the DENSITOMETRY family, which now means two instruments
// rather than one: hydrostatic 2026 and skinfold 2015 sit on a common level, and
// the InBody pair sits 2.2 pp off it. Consequence worth knowing, unchanged: every
// reading reads ~2.2 pp leaner than an InBody-anchored fit would place it,
// including the whole pre-2024 history.
//
// ── Why the bias is nearly flat ───────────────────────────────────────────────
// The slope is still barely distinguishable from zero, so BETA remains the raw
// estimate shrunk by t²/(1+t²). The 2015 anchor improves it without rescuing it:
// t goes 0.66 → 1.40, and the shrunk value barely moves (0.02012 → 0.01810).
// Encouragingly, the two same-family pairs now bracket it from both sides —
// InBody-only gives 0.0669, densitometry-only gives 0.0176 — and the joint
// estimate of 0.0274 sits between them. The old worry was that a slope fitted
// ACROSS instruments absorbs the method offset: that produced 5× the within-
// device slope which, projected past 183 lbs, reported FAT LOSS during weight
// gain at an unchanged scale reading, and FFMI above the natural ceiling by
// 190 lbs. Holding the offset as its own term is what stops that, and with four
// anchors it is now measured (−2.215 ± 0.174 pp) instead of asserted.

// ── Weight correction (constant) ──────────────────────────────────────────────
// Mean of (scale − gold) over the anchors whose two sides are ACTUALLY
// comparable: home scale and lab scale both morning-fasted. That is the two
// InBody visits, +1.30 and +0.90.
//
// The premise is the point. Pairing a same-day home reading against a lab
// reading is only a device comparison if both carry the same hydration and gut
// state; otherwise it measures breakfast. Two anchors fail that test and are
// excluded:
//
//   2026-02-20  hydrostatic, NOT fasted   scale − gold = +1.50
//   2015-05-15  skinfold, fasting unknown scale − gold = −0.60
//
// Note they straddle the estimate rather than agreeing with it, and the fed one
// is the HIGH side — the opposite of what gut contents in the lab weight would
// do. So the spread here is lab-scale-to-lab-scale difference, not fasting, and
// no reweighting of these four numbers would extract the device offset. Two
// clean pairs is the honest sample; 1.10 ± 0.20 lbs is the real precision.
//
// (Smoothing one side and not the other mixes trend into a same-day comparison
// and scatters the estimate — 1.3/0.9/1.5 → 2.4/0.9/1.2 — so both sides stay raw.)
//
// This constant is deliberately kept OUT of the fat% fit: scale-lean is computed
// from the raw scale weight, so the anchor coefficients above do not move when
// this number changes. It only rescales the mass series.
const WEIGHT_BIAS = 1.10;

// ── Fat% bias model ───────────────────────────────────────────────────────────
// bias(L) = BIAS_REF + BETA · (L − LM_REF),  L = scale-implied lean mass.
//
// Anchor scale values are Gaussian kernel means (σ = 14 d) rather than the
// nearest single reading. A lone BIA reading carries ~0.80 pp of noise — measured
// over 1120 readings — and the old ±7-day weighting pooled an effective 1.0–1.2
// readings, so it removed none of it. Fat% is a slow-moving quantity under fast
// noise, so averaging is the right estimator; σ = 14 d pools ~4 readings without
// reaching far enough to import a trend. It moved the 2026 anchor by −0.79 pp.
const BIAS_REF = 6.3669;    // pp, at LM_REF on the densitometry level (se 0.16)
const LM_REF   = 147.0079;  // lbs of scale-lean at the hydrostatic anchor
const BETA     = 0.01810;   // pp per lb of scale-lean (shrunk from 0.02740)

// How much higher an InBody fat% reads than densitometry at the same body.
// Fitted, not assumed. Runtime calibration never applies it — the model is
// anchored on densitometry — but it is what puts an InBody number onto the same
// scale as the rest of the series, so the charts use it to overlay the scans.
const IB_METHOD_OFFSET = -2.2152;   // pp; densitometry ≈ InBody + this

// Scale-lean actually spanned by the anchors. Outside it the slope is untested,
// so it decays instead of running: the bias may drift at most BETA · LM_TAPER
// (≈0.30 pp) beyond either end, then flattens. Extrapolating a fitted slope past
// its own data is what broke the previous version.
// LM_LO is the 2015 skinfold anchor; before it existed the low end was 137.81,
// which left 73% of the reading history on the taper instead of inside the fit.
const LM_LO = 135.85, LM_HI = 147.01;
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
// current history (which spans 7.1–15.1% fat and FFMI 20.2–23.8). They exist so
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

// ── Anchors as data ───────────────────────────────────────────────────────────
// The same four scans the constants above were fitted to, exported so the charts
// can draw them over the calibrated series instead of the numbers living in two
// places. `fat_lbs` is on the DENSITOMETRY level: the InBody rows get
// IB_METHOD_OFFSET applied so all four are comparable to the plotted curve.
//
// Fat MASS rather than fat% is what gets exposed, and that is not incidental —
// it is the quantity that survives the fed-state problem. Non-fasted gut
// contents are fat-free mass: they inflate the weight and dilute the percentage
// while leaving the pounds of fat essentially untouched. So the 2026 hydrostatic
// row and the 2015 row, whose fasting state is unknown, are both plotted on the
// axis least disturbed by it.
const ANCHORS = [
    { date: '2015-05-15', method: 'Skinfold (JP7)', weight: 161.8, fat: 9.7,  bia: false },
    { date: '2024-11-23', method: 'InBody',         weight: 166.5, fat: 14.6, bia: true  },
    { date: '2025-03-21', method: 'InBody',         weight: 171.5, fat: 12.7, bia: true  },
    { date: '2026-02-20', method: 'Hydrostatic',    weight: 181.5, fat: 13.2, bia: false },
].map(a => {
    const fatDensi = a.fat + (a.bia ? IB_METHOD_OFFSET : 0);
    return { ...a, fat_densi: fatDensi, fat_lbs: a.weight * fatDensi / 100 };
});

window.calibrate = calibrate;
window.ANCHORS = ANCHORS;
