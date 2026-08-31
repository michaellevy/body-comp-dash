// Main app logic — tabs, form, slider, chart orchestration

document.addEventListener('DOMContentLoaded', async () => {
    // ── Tabs ───────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.target).classList.add('active');
            if (tab.dataset.target === 'log-tab') { refreshRecent(); refreshTapeDue(); }
            if (tab.dataset.target === 'charts-tab') refreshCharts();
        });
    });

    // ── Settings gear ─────────────────────────────────
    const settingsPanel = document.getElementById('settings-panel');
    const ghTokenInput = document.getElementById('input-gh-token');
    const ghGistInput = document.getElementById('input-gh-gist');

    // Pre-fill if already configured
    ghTokenInput.value = localStorage.getItem('gh_token') || '';
    ghGistInput.value = localStorage.getItem('gh_gist_id') || '';

    const heightInput = document.getElementById('input-height');
    heightInput.value = db.getHeight() ?? '';
    heightInput.addEventListener('change', () => {
        const h = parseFloat(heightInput.value);
        if (!isNaN(h) && h > 0) {
            db.setHeight(h);
            refreshCharts();
        }
    });

    document.getElementById('clear-cache-btn').addEventListener('click', async () => {
        // Unregister service worker and delete all caches for this scope
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
        location.reload();
    });

    document.getElementById('gear-btn').addEventListener('click', () => {
        const open = settingsPanel.style.display !== 'none';
        settingsPanel.style.display = open ? 'none' : 'block';
    });

    document.getElementById('gh-save-btn').addEventListener('click', async () => {
        const fb = document.getElementById('gh-feedback');
        const token = ghTokenInput.value.trim();
        const gistId = ghGistInput.value.trim();
        if (!token || !gistId) {
            fb.textContent = 'Both fields are required.';
            fb.className = 'err';
            return;
        }
        db.setGist(token, gistId);
        fb.textContent = 'Syncing...';
        fb.className = '';
        try {
            const pulled = await db.syncFromCloud();
            const total = await db.syncToCloud();
            fb.textContent = `Pulled ${pulled} from gist, pushed ${total} back.`;
            fb.className = 'ok';
            refreshRecent();
        } catch (e) {
            fb.textContent = 'Sync failed: ' + e.message;
            fb.className = 'err';
        }
    });

    // ── Date default ───────────────────────────────────
    const dateInput = document.getElementById('input-date');
    dateInput.value = tape.todayStr();

    // ── Save ───────────────────────────────────────────
    document.getElementById('save-btn').addEventListener('click', async () => {
        const weight = document.getElementById('input-weight').value;
        const fat = document.getElementById('input-fat').value;
        const feedback = document.getElementById('feedback');

        // Tape can be logged on its own — a due waist reading shouldn't be
        // blocked just because you already weighed in this morning.
        const tapeValues = {};
        document.querySelectorAll('.tape-input').forEach(inp => {
            if (inp.value !== '') tapeValues[inp.dataset.site] = inp.value;
        });
        const tapeKeys = Object.keys(tapeValues);

        if (!weight && !tapeKeys.length) {
            feedback.textContent = 'Enter a weight or a measurement.';
            feedback.className = 'err';
            return;
        }

        const dt = dateInput.value || tape.todayStr();

        const parts = [];
        if (weight) {
            await db.saveMeasurement(dt, weight, fat || null);
            parts.push(`${weight} lbs${fat ? `, ${fat}% fat` : ''}`);
        }
        if (tapeKeys.length) {
            await db.saveTape(dt, tapeValues);
            parts.push(tapeKeys.map(k => `${k} ${tapeValues[k]}"`).join(', '));
        }

        const d = new Date(dt + 'T00:00:00');
        const mon = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        feedback.textContent = `Saved ${mon} — ${parts.join(' · ')}`;
        feedback.className = 'ok';

        document.getElementById('input-weight').value = '';
        document.getElementById('input-fat').value = '';
        showResting = false;
        await refreshTapeDue();

        // Switch to Charts tab
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.querySelector('[data-target="charts-tab"]').classList.add('active');
        document.getElementById('charts-tab').classList.add('active');
        refreshCharts();
    });

    // ── Circumference prompts ──────────────────────────
    // Due sites render on their own and stay until actually recorded. Dueness
    // is recomputed from stored data every render, so there's nothing to
    // dismiss and nothing that can be lost by reloading. Sites that aren't due
    // are one button away — the cadences are a floor on useful signal, not a
    // lock, so an off-schedule reading should never be impossible to enter.
    let showResting = false;

    // A tape is read in eighths, so a reading can carry three decimals
    // (36 5/8 → 36.625). Trim trailing zeros rather than fixing the width:
    // rounding to 0.1 would throw away a real eighth of an inch.
    function fmtIn(v) {
        return parseFloat(v.toFixed(3)).toString();
    }

    function tapeField(site, rows, today, dueIn) {
        const last = tape.lastRecorded(rows, site.key);
        const bits = [];
        if (last) {
            bits.push(`Last time: ${fmtIn(last[site.key])} in · ${tape.daysBetween(last.date, today)} days ago`);
        }
        if (dueIn > 0) bits.push(`next due in ${dueIn} ${dueIn === 1 ? 'day' : 'days'}`);
        const ref = bits.length ? `<div class="tape-last">${bits.join(' · ')}</div>` : '';

        // Full width, one site per row: the cue is the point, and it has to be
        // readable without wrapping into a narrow column.
        return `<div class="tape-field">
            <label for="input-tape-${site.key}">${site.label} (in)</label>
            <div class="tape-cue">${site.cue}</div>
            <input type="number" id="input-tape-${site.key}" class="tape-input"
                   step="any" inputmode="decimal" data-site="${site.key}">
            ${ref}
        </div>`;
    }

    async function refreshTapeDue() {
        const el = document.getElementById('tape-due');
        const rows = await db.getAllTape();
        const today = tape.todayStr();
        const due = tape.dueSites(rows);
        const resting = tape.restingSites(rows);

        // Nothing is on offer only if every site is showing already.
        const showToggle = resting.length > 0;
        const visible = showResting ? due.concat(resting) : due;

        const parts = [`<div class="tape-block-header">Tape measure</div>`];
        if (visible.length) {
            parts.push(`<div class="tape-shared-cue">${tape.SHARED_CUE}</div>`);
            parts.push(...visible.map(site =>
                tapeField(site, rows, today, tape.daysUntilDue(rows, site, today))));
        } else {
            parts.push(`<div class="tape-shared-cue">Nothing due today.</div>`);
        }
        if (showToggle) {
            parts.push(`<button type="button" id="tape-more-btn" class="tape-more">${
                showResting ? 'Hide off-schedule sites' : 'Measure something else'
            }</button>`);
        }

        el.innerHTML = `<div class="tape-block">${parts.join('')}</div>`;

        const moreBtn = document.getElementById('tape-more-btn');
        if (moreBtn) {
            moreBtn.addEventListener('click', () => {
                showResting = !showResting;
                refreshTapeDue();
            });
        }
    }

    // ── Recent entries ─────────────────────────────────
    async function refreshRecent() {
        const el = document.getElementById('recent-entries');
        const recent = await db.getRecentMeasurements(7);
        if (!recent.length) {
            el.innerHTML = '<div class="muted">No entries yet.</div>';
            return;
        }
        let html = '<div class="entry-header"><span>Date</span><span>Weight</span><span>Fat%</span></div>';
        recent.reverse().forEach(r => {
            const fat = r.fat_percent != null ? r.fat_percent.toFixed(1) : '—';
            html += `<div class="entry-row"><span>${r.date}</span><span>${r.weight.toFixed(1)}</span><span>${fat}</span></div>`;
        });
        el.innerHTML = html;
    }

    // ── Range control ──────────────────────────────────
    // Two ways in, one piece of state. The slider spans the whole history one
    // month per step, which makes the recent end unreachable on a phone: with
    // years of data a three-month window is a few pixels of travel pinned
    // against the right edge. The presets jump straight to those short windows.
    // `sinceDate` is what the charts actually read, so neither control can
    // disagree with what's on screen.
    const slider = document.getElementById('range-slider');
    const sliderLabel = document.getElementById('slider-label');
    const presetRow = document.getElementById('range-presets');
    let allData = [];
    let sinceDate = null;   // 'YYYY-MM-DD', or null for the full history

    // Presets count back from today rather than snapping to a month boundary —
    // "1M" on the 20th should mean four weeks, not seven.
    function monthsAgo(n) {
        const now = new Date();
        const d = new Date(now.getFullYear(), now.getMonth() - n, now.getDate());
        // Day overflow: Aug 31 minus six months is Feb 31, which rolls forward
        // into March. setDate(0) pulls back to the last day of the month we
        // meant, so the window is never shorter than asked for.
        if (d.getDate() !== now.getDate()) d.setDate(0);
        return tape.localDateStr(d);
    }

    function monthsLabel(n) {
        if (n === 1) return 'Last month';
        if (n === 12) return 'Last year';
        if (n % 12 === 0) return `Last ${n / 12} years`;
        return `Last ${n} months`;
    }

    // The slider keeps its month-boundary semantics: dragging it is a coarse
    // "show me from about here" gesture, and a whole month reads cleaner as a
    // label than whatever day the thumb happened to land on.
    function sliderToDate(val) {
        const months = parseInt(slider.max) - parseInt(val);
        if (months <= 0) return null;
        const now = new Date();
        return tape.localDateStr(new Date(now.getFullYear(), now.getMonth() - months, 1));
    }

    function markPreset(months) {
        presetRow.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active', months !== null && +b.dataset.months === months);
        });
    }

    // Moving the slider hands control back to it, so whichever pill was lit is
    // no longer describing the window and gets cleared.
    function setFromSlider() {
        sinceDate = sliderToDate(slider.value);
        markPreset(null);
        sliderLabel.textContent = sinceDate ? 'From ' + sinceDate.slice(0, 7) : 'All data';
    }

    function setPreset(months) {
        sinceDate = months > 0 ? monthsAgo(months) : null;
        // Park the thumb at the matching month so the slider reads as the same
        // window, and a follow-up drag starts from where the preset left off.
        slider.value = months > 0 ? Math.max(0, parseInt(slider.max) - months) : 0;
        markPreset(months);
        sliderLabel.textContent = months > 0 ? monthsLabel(months) : 'All data';
    }

    presetRow.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        setPreset(+btn.dataset.months);
        refreshCharts();
    });

    slider.addEventListener('input', setFromSlider);
    slider.addEventListener('change', () => { refreshCharts(); });

    // ── Charts ─────────────────────────────────────────
    // Hide a chart's card entirely when it has nothing to show, rather than
    // leaving an empty bordered box on the page.
    function showCard(chartId, visible) {
        document.getElementById(chartId).closest('.card').style.display = visible ? '' : 'none';
    }

    // ── Linked date range ──────────────────────────────
    // Every chart with a date x-axis shows the same window. The slider sets the
    // coarse window; zooming or panning inside ANY one of them re-broadcasts the
    // new range to the rest, so the dashboard never shows two different spans
    // side by side. The path chart has no date axis, so it can't be relayed to —
    // it follows by re-rendering from the data inside the window instead.
    const TIME_CHARTS = ['weight-chart', 'muscle-fat-chart', 'waist-chart',
                         'bicep-chart', 'thigh-chart', 'neck-chart', 'navy-chart'];

    let chartData = { cal: [], tape: [], navy: [] };  // slider-filtered, for the shared window
    let linkedRange = null;        // the window every chart is currently showing
    let broadcasting = false;      // suppresses the echo from our own relayouts

    // A chart div only counts once it has been plotted and its card is visible —
    // relayout on a purged or hidden div is either an error or invisible work.
    function liveCharts() {
        return TIME_CHARTS.filter(id => {
            const gd = document.getElementById(id);
            return gd && gd.data && gd.closest('.card').style.display !== 'none';
        });
    }

    // Plotly reports the axis that was actually dragged, which on the muscle/fat
    // pair is xaxis2 as often as xaxis — hence the digit in the patterns. A
    // double-click reports autorange instead of a range.
    function xRangeFromEvent(ev) {
        const keys = Object.keys(ev);
        if (keys.some(k => /^xaxis\d*\.autorange$/.test(k) && ev[k] === true)) return { range: null };
        const k0 = keys.find(k => /^xaxis\d*\.range\[0\]$/.test(k));
        if (k0) return { range: [ev[k0], ev[k0.replace('[0]', '[1]')]] };
        const kr = keys.find(k => /^xaxis\d*\.range$/.test(k));
        if (kr) return { range: ev[kr].slice() };
        return null;  // resize, y-zoom, legend click — nothing to sync
    }

    // Plotly hands back date-axis bounds as "2026-03-14 08:12:33.9". Safari
    // rejects the space form, so normalize before parsing — and pin the result to
    // UTC, which is how Plotly reads a bare "YYYY-MM-DD" in the data itself.
    // Parsing one end local and the other UTC would skew every comparison here by
    // the timezone offset.
    function toMs(v) {
        if (v == null) return null;
        if (typeof v === 'number') return v;
        let s = String(v).trim().replace(' ', 'T');
        if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
        const t = new Date(s).getTime();
        return isNaN(t) ? null : t;
    }

    function sameRange(a, b) {
        if (!a || !b) return a === b;
        return toMs(a[0]) === toMs(b[0]) && toMs(a[1]) === toMs(b[1]);
    }

    function withinRange(rows, range) {
        if (!range) return rows;
        const lo = toMs(range[0]), hi = toMs(range[1]);
        if (lo == null || hi == null) return rows;
        return rows.filter(r => {
            const t = toMs(r.date);
            return t >= lo && t <= hi;
        });
    }

    // The window every chart resets to. Autorange can't serve as the shared
    // "everything" view because each chart would size to its OWN series — weight
    // stops at the last weigh-in, the tape sites run on to the last measuring
    // day — and a double-click would pull the dashboard back out of alignment.
    // So the reset target is the span of all the data on the page at once.
    function windowRange() {
        let lo = Infinity, hi = -Infinity;
        [chartData.cal, chartData.tape, chartData.navy].forEach(rows => {
            (rows || []).forEach(r => {
                const t = toMs(r.date);
                if (t == null) return;
                if (t < lo) lo = t;
                if (t > hi) hi = t;
            });
        });
        if (!isFinite(lo) || hi <= lo) return null;
        const pad = Math.max((hi - lo) * 0.03, 86400000);
        return [lo - pad, hi + pad];
    }

    // The path chart aggregates to quarters, so a window holding one quarter has
    // no arrow to draw — hide the card rather than show an empty box.
    function renderPath(range) {
        const rows = withinRange(chartData.cal, range);
        const quarters = new Set(rows
            .filter(r => r.fat_lbs != null && r.muscle_lbs != null)
            .map(r => { const d = new Date(r.date); return `${d.getFullYear()}-${d.getMonth() / 3 | 0}`; }));
        charts.renderPathChart('path-chart', rows);
        showCard('path-chart', quarters.size >= 2);
    }

    // Every chart — and our own record of the window — gets its OWN copy of the
    // bounds array. Plotly keeps whatever array it's handed as the axis range and
    // rewrites it in place on the next drag, so a shared array would let one
    // chart's zoom silently redefine what the others think they're showing, and
    // would leave linkedRange always equal to the range that just arrived.
    function broadcastRange(range, sourceId) {
        const target = range ? range.slice() : null;
        linkedRange = target;
        broadcasting = true;
        liveCharts().forEach(id => {
            if (id === sourceId) return;
            // The matched second axis on the muscle/fat chart follows xaxis on
            // its own, so one key covers both subplots.
            Plotly.relayout(document.getElementById(id), target
                ? { 'xaxis.range': target.slice(), 'xaxis.autorange': false }
                : { 'xaxis.autorange': true });
        });
        renderPath(target);
        // Plotly may emit the resulting relayout after its redraw settles, so
        // hold the guard past the current task rather than clearing it inline.
        setTimeout(() => { broadcasting = false; }, 0);
    }

    // newPlot re-initializes the div, so handlers are re-bound after every
    // render; removeAllListeners keeps that from stacking duplicates.
    function wireRangeLinking() {
        liveCharts().forEach(id => {
            const gd = document.getElementById(id);
            gd.removeAllListeners('plotly_relayout');
            gd.on('plotly_relayout', ev => {
                if (broadcasting) return;
                const got = xRangeFromEvent(ev);
                if (!got) return;
                if (got.range) {
                    if (sameRange(got.range, linkedRange)) return;
                    broadcastRange(got.range, id);
                } else {
                    // Double-click reset. The source has already autoranged to its
                    // own extent, so it needs the shared window pushed to it too —
                    // no sourceId, everybody gets the update.
                    broadcastRange(windowRange(), null);
                }
            });
        });
    }

    async function refreshCharts() {
        allData = await db.getAllMeasurements();
        const tapeRows = await db.getAllTape();
        const since = sinceDate;

        // Calibration is per-row and takes no notice of the window, so the whole
        // history is calibrated once and sliced. Both halves are needed: the
        // window supplies markers and axis ranges, the full series is what the
        // smoother is fitted on. Refitting a trend on a slice of the data would
        // throw away the history the noise model needs — see smoothWindowed.
        const calAll = calibrate(allData);
        const cal = since ? calAll.filter(r => r.date >= since) : calAll;
        const filteredTape = since ? tapeRows.filter(r => r.date >= since) : tapeRows;

        // Navy is computed over the full history first, then filtered: neck is
        // carried forward from the last monthly reading, which may sit before
        // the slider window.
        const navyAll = tape.navySeries(tapeRows, db.getHeight());
        const navyRows = since ? navyAll.filter(r => r.date >= since) : navyAll;

        // The range control is the master: changing it drops any zoom the charts
        // were holding, so they all come back on the new window together.
        chartData = { cal, tape: filteredTape, navy: navyRows };
        linkedRange = null;

        charts.renderWeightChart('weight-chart', cal, calAll);
        charts.renderMuscleFatChart('muscle-fat-chart', cal, calAll);
        renderPath(null);

        // Waist is measured every few days, so it earns a smoothed trend; the
        // monthly sites are too sparse for smoothing and get a plain connector.
        [
            ['waist-chart', 'waist', 'Waist', true],
            ['bicep-chart', 'bicep', 'Bicep', false],
            ['thigh-chart', 'thigh', 'Thigh', false],
            ['neck-chart',  'neck',  'Neck',  false],
        ].forEach(([id, key, label, dense]) => {
            charts.renderCircumferenceChart(id, filteredTape, key, label, dense, tapeRows);
            showCard(id, filteredTape.some(r => r[key] != null));
        });

        charts.renderNavyChart('navy-chart', navyRows, cal, navyAll, calAll);
        showCard('navy-chart', navyRows.length > 0);

        // A short preset can land on a stretch with nothing logged, which would
        // otherwise hide every card and leave the page looking broken.
        const empty = document.getElementById('range-empty');
        const nothing = cal.length === 0 && filteredTape.length === 0;
        empty.style.display = nothing ? '' : 'none';
        empty.textContent = nothing ? 'Nothing logged in this window.' : '';

        wireRangeLinking();
        // Start every chart on the shared window rather than on its own autorange,
        // so they line up before the first zoom, not just after one.
        const full = windowRange();
        if (full) broadcastRange(full, null);
    }

    // ── Init ───────────────────────────────────────────
    // Auto-sync from cloud on load, then repair. Order matters: the pull can
    // bring back rows a data fix is meant to remove, so fixing first would be
    // undone on every launch.
    (async () => {
        if (db.gistConfigured()) {
            try {
                await db.syncFromCloud();
            } catch (e) {
                console.warn('Auto-sync failed:', e.message);
            }
        }
        await db.applyDataFixes();
        refreshRecent();
        refreshTapeDue();
    })();

    // Size the slider to the data, and drop presets that reach past the start of
    // it — on a two-month history a "3Y" pill is just another way to say "All".
    const all = await db.getAllMeasurements();
    let totalMonths = 0;
    if (all.length) {
        const earliest = new Date(all[0].date);
        const now = new Date();
        totalMonths = (now.getFullYear() - earliest.getFullYear()) * 12 + (now.getMonth() - earliest.getMonth());
        slider.max = totalMonths;
        presetRow.querySelectorAll('button').forEach(b => {
            const m = +b.dataset.months;
            if (m > 0 && m >= totalMonths) b.style.display = 'none';
        });
    }
    // Default to the last month: the question this dashboard gets asked most is
    // "what is happening now". Safe to make the default only because the
    // smoother no longer refits on the window — a one-month view crops the
    // all-time trend rather than recomputing one from thirty days of readings.
    // With less than a month on record the two windows are the same, and "All"
    // is the more honest label for it.
    setPreset(totalMonths > 1 ? 1 : 0);
    refreshRecent();
    refreshTapeDue();
});
