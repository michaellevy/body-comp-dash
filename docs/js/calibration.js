// Body composition calibration — ported from calibration.py
// All constants derived from historical data and InBody scans.

const MUSCLE_MODEL = {
    intercept: 48.85907224831961,
    weightCoef: 0.011898676042334806,
    fatCoef: -0.5854039862344727,
};

const FAT_CAL = { slope: 1.3571428571428543, intercept: -10.642857142857094 };
const MUSCLE_CAL = { slope: 1.5102900374010793, intercept: -11.653288737165814 };

function calibrate(rows) {
    // rows: [{date, weight, fat_percent}, ...]
    // Returns new array with added: muscle_percent, fat_lbs, muscle_lbs
    return rows.map(r => {
        const out = { ...r };
        if (r.fat_percent == null || r.weight == null) return out;

        // Raw muscle% estimate
        let musclePct = MUSCLE_MODEL.intercept
            + r.weight * MUSCLE_MODEL.weightCoef
            + r.fat_percent * MUSCLE_MODEL.fatCoef;

        // Affine calibration
        let fatPct = FAT_CAL.slope * r.fat_percent + FAT_CAL.intercept;
        musclePct = MUSCLE_CAL.slope * musclePct + MUSCLE_CAL.intercept;

        out.fat_percent_cal = fatPct;
        out.muscle_percent = musclePct;
        out.fat_lbs = r.weight * fatPct / 100;
        out.muscle_lbs = r.weight * musclePct / 100;
        return out;
    });
}

window.calibrate = calibrate;
