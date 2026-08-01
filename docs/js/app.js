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
    dateInput.value = new Date().toISOString().slice(0, 10);

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

        const dt = dateInput.value || new Date().toISOString().slice(0, 10);

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
        await refreshTapeDue();

        // Switch to Charts tab
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.querySelector('[data-target="charts-tab"]').classList.add('active');
        document.getElementById('charts-tab').classList.add('active');
        refreshCharts();
    });

    // ── Due circumference prompts ──────────────────────
    // Fields appear only when a site is due and stay until it's recorded.
    // Dueness is recomputed from stored data every render, so there's nothing
    // to dismiss and nothing that can be lost by reloading.
    async function refreshTapeDue() {
        const el = document.getElementById('tape-due');
        const rows = await db.getAllTape();
        const due = tape.dueSites(rows);

        if (!due.length) {
            el.innerHTML = '';
            return;
        }

        const today = tape.todayStr();

        // Full width, one site per row: the cue is the point, and it has to be
        // readable without wrapping into a narrow column.
        const fields = due.map(site => {
            const last = tape.lastRecorded(rows, site.key);
            const ref = last
                ? `<div class="tape-last">Last time: ${last[site.key].toFixed(1)} in · ${tape.daysBetween(last.date, today)} days ago</div>`
                : '';
            return `<div class="tape-field">
                <label for="input-tape-${site.key}">${site.label} (in)</label>
                <div class="tape-cue">${site.cue}</div>
                <input type="number" id="input-tape-${site.key}" class="tape-input"
                       step="0.1" inputmode="decimal" data-site="${site.key}">
                ${ref}
            </div>`;
        });

        el.innerHTML = `<div class="tape-block">
            <div class="tape-block-header">Tape measure</div>
            <div class="tape-shared-cue">${tape.SHARED_CUE}</div>
            ${fields.join('')}
        </div>`;
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

    // ── Slider ─────────────────────────────────────────
    const slider = document.getElementById('range-slider');
    const sliderLabel = document.getElementById('slider-label');
    let allData = [];

    function sliderToDate(val) {
        const now = new Date();
        const months = parseInt(slider.max) - parseInt(val);
        if (months <= 0) return null; // all data
        const d = new Date(now.getFullYear(), now.getMonth() - months, 1);
        return d.toISOString().slice(0, 10);
    }

    function updateSliderLabel() {
        const since = sliderToDate(slider.value);
        if (!since) {
            sliderLabel.textContent = 'All data';
        } else {
            sliderLabel.textContent = 'From ' + since.slice(0, 7);
        }
    }

    slider.addEventListener('input', () => {
        updateSliderLabel();
    });

    slider.addEventListener('change', () => {
        refreshCharts();
    });

    // ── Charts ─────────────────────────────────────────
    // Hide a chart's card entirely when it has nothing to show, rather than
    // leaving an empty bordered box on the page.
    function showCard(chartId, visible) {
        document.getElementById(chartId).closest('.card').style.display = visible ? '' : 'none';
    }

    async function refreshCharts() {
        allData = await db.getAllMeasurements();
        const tapeRows = await db.getAllTape();
        const since = sliderToDate(slider.value);

        let filtered = allData;
        let filteredTape = tapeRows;
        if (since) {
            filtered = allData.filter(r => r.date >= since);
            filteredTape = tapeRows.filter(r => r.date >= since);
        }
        const cal = calibrate(filtered);

        // Navy is computed over the full history first, then filtered: neck is
        // carried forward from the last monthly reading, which may sit before
        // the slider window.
        const navyAll = tape.navySeries(tapeRows, db.getHeight());
        const navyRows = since ? navyAll.filter(r => r.date >= since) : navyAll;

        charts.renderWeightChart('weight-chart', cal);
        charts.renderMuscleFatChart('muscle-fat-chart', cal);
        charts.renderPathChart('path-chart', cal);

        // Waist is weekly, so it earns a smoothed trend; the monthly sites are
        // too sparse for smoothing and get a plain connector.
        [
            ['waist-chart', 'waist', 'Waist', true],
            ['bicep-chart', 'bicep', 'Bicep', false],
            ['thigh-chart', 'thigh', 'Thigh', false],
            ['neck-chart',  'neck',  'Neck',  false],
        ].forEach(([id, key, label, dense]) => {
            charts.renderCircumferenceChart(id, filteredTape, key, label, dense);
            showCard(id, filteredTape.some(r => r[key] != null));
        });

        charts.renderNavyChart('navy-chart', navyRows, cal);
        showCard('navy-chart', navyRows.length > 0);
    }

    // ── Init ───────────────────────────────────────────
    // Auto-sync from cloud on load
    if (db.gistConfigured()) {
        db.syncFromCloud()
            .then(() => { refreshRecent(); refreshTapeDue(); })
            .catch(e => console.warn('Auto-sync failed:', e.message));
    }

    // Set slider range based on data
    const all = await db.getAllMeasurements();
    if (all.length) {
        const earliest = new Date(all[0].date);
        const now = new Date();
        const totalMonths = (now.getFullYear() - earliest.getFullYear()) * 12 + (now.getMonth() - earliest.getMonth());
        slider.max = totalMonths;
        slider.value = Math.max(0, totalMonths - 12); // default 1 year
    }
    updateSliderLabel();
    refreshRecent();
    refreshTapeDue();
});
