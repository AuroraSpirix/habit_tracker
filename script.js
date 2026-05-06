// ─── JSONBin Storage Layer ────────────────────────────────────────────────────
// Single source of truth: one JSONBin document holds ALL app data as a flat
// key→value map (values are JSON strings, matching the localStorage API).
// A synchronous in-memory cache lets the rest of the code stay unchanged.

const JSONBIN_URL = 'https://api.jsonbin.io/v3/b/69f53af2856a6821899747a5';

const JSONBIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Master-Key': '$2a$10$3y.dwt/3tzWk3GSu3tXtDeFKHKk25l68iLnGPUjauJA8zdcHfmMji'
};

let _cache = {};          // in-memory mirror of the bin
let _saveTimer = null;    // debounce handle

const Storage = {
    getItem(key) {
        return Object.prototype.hasOwnProperty.call(_cache, key) ? _cache[key] : null;
    },
    setItem(key, value) {
        _cache[key] = value;
        _scheduleSave();
    },
    removeItem(key) {
        delete _cache[key];
        _scheduleSave();
    }
};

function _scheduleSave() {
    if (_saveTimer) return; // already scheduled
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        _flushToJsonBin();
    }, 10000); // save 10 seconds after the first change
}

// Save immediately when the user closes/leaves the page
// sendBeacon is more reliable than fetch in beforeunload
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        clearTimeout(_saveTimer);
        _saveTimer = null;
        const blob = new Blob([JSON.stringify(_cache)], { type: 'application/json' });
        navigator.sendBeacon(JSONBIN_URL, blob);
    }
});

async function _flushToJsonBin() {
    try {
        await fetch(JSONBIN_URL, {
            method: 'PUT',
            headers: JSONBIN_HEADERS,
            body: JSON.stringify(_cache)
        });
    } catch (e) {
        console.warn('JSONBin save failed:', e);
    }
}

async function _loadFromJsonBin() {
    try {
        const res = await fetch(JSONBIN_URL + '/latest', { headers: JSONBIN_HEADERS });
        if (res.ok) {
            const data = await res.json();
            _cache = data.record || {};
        }
    } catch (e) {
        console.warn('JSONBin load failed, starting fresh:', e);
        _cache = {};
    }
}
// ─────────────────────────────────────────────────────────────────────────────
const svg = document.getElementById('radarChart');
const statsDisplay = document.getElementById('stats-display');


const centerX = 200;
const centerY = 200;
const radius = 150;
const maxValue = 10;
const STORAGE_KEY = 'vitals_tracker_data';
const SPIRITUAL_KEY = 'spiritual_entries';

let viewDate = new Date();
let categories = [];
let isDragging = false;
let currentHandleIdx = null;
// ─── RADAR CHART LABELS ───────────────────────────────────────────────────
// The order of items in this array determines the order of labels around the
// radar chart, starting from the TOP and going CLOCKWISE.
//
//                    [0] (top)
//                  /         \
//              [5]             [1]
//               |               |
//              [4]             [2]
//                  \         /
//                    [3] (bottom)
//
// To reorder labels, just rearrange the items in this array.
// The "value" is the default starting value (out of 10) for an untouched dot.
const defaultValues = [
    { name: 'Spirituality', value: 2, note: '' },
    { name: 'Mobility', value: 2, note: '' },
    { name: 'Mindset', value: 2, note: '' },
    { name: 'Mindfulness', value: 2, note: '' },
    { name: 'Recovery', value: 2, note: '' },
    { name: 'Reflection', value: 2, note: '' }
];

const avoidedActivitiesList = ['Pride', 'Greed', 'Lust', 'Envy', 'Gluttony', 'Wrath', 'Sloth'];
const christLikeAttributesList = ['Faith', 'Hope', 'Charity', 'Patience', 'Humility', 'Diligence', 'Integrity'];
let avoidedToday = []; // legacy — kept so old saved data still loads cleanly
const SIN_LEVELS_KEY = 'sin_levels';
const VIRTUE_LEVELS_KEY = 'virtue_levels';
const VIRTUE_ENTRIES_KEY = 'virtue_entries';
const AVOIDED_ENTRIES_KEY = 'avoided_entries';

// Which slider set is currently visible — 'sins' or 'virtues'.
// Persisted so the user's preference survives page reloads.
const MIXER_MODE_KEY = 'mixer_mode';
function getMixerMode() {
    return Storage.getItem(MIXER_MODE_KEY) || 'sins';
}
function setMixerMode(mode) {
    Storage.setItem(MIXER_MODE_KEY, mode);
}

// Per-mode config so the renderer doesn't need branchy if/else everywhere.
function getMixerConfig(mode) {
    if (mode === 'virtues') {
        return {
            list: christLikeAttributesList,
            levelsKey: VIRTUE_LEVELS_KEY,
            entriesKey: VIRTUE_ENTRIES_KEY,
        };
    }
    return {
        list: avoidedActivitiesList,
        levelsKey: SIN_LEVELS_KEY,
        entriesKey: AVOIDED_ENTRIES_KEY,
    };
}

function getAllSinLevels() {
    try { return JSON.parse(Storage.getItem(SIN_LEVELS_KEY)) || {}; }
    catch(e) { return {}; }
}
function getSinLevelsForDay() {
    return getAllSinLevels()[getDateKey(viewDate)] || {};
}
function setSinLevel(activity, value) {
    const all = getAllSinLevels();
    const dayKey = getDateKey(viewDate);
    if (!all[dayKey]) all[dayKey] = {};
    if (value === 0) {
        delete all[dayKey][activity];
        if (Object.keys(all[dayKey]).length === 0) delete all[dayKey];
    } else {
        all[dayKey][activity] = value;
    }
    Storage.setItem(SIN_LEVELS_KEY, JSON.stringify(all));
}

// Generic versions used by the mixer renderer — work with any storage key.
// Keep the sin-specific ones above so existing callers (if any) still work.
function getAllLevels(key) {
    try { return JSON.parse(Storage.getItem(key)) || {}; }
    catch(e) { return {}; }
}
function getLevelsForDay(key) {
    return getAllLevels(key)[getDateKey(viewDate)] || {};
}
function setLevel(key, activity, value) {
    const all = getAllLevels(key);
    const dayKey = getDateKey(viewDate);
    if (!all[dayKey]) all[dayKey] = {};
    if (value === 0) {
        delete all[dayKey][activity];
        if (Object.keys(all[dayKey]).length === 0) delete all[dayKey];
    } else {
        all[dayKey][activity] = value;
    }
    Storage.setItem(key, JSON.stringify(all));
}


function getDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Returns true if a category has any data saved for the current viewDate
function isCategoryCompleted(catName) {
    if (catName === 'Spirituality') {
        const all = JSON.parse(Storage.getItem(SPIRITUAL_KEY) || '{}');
        const entries = all[getDateKey(viewDate)] || [];
        return entries.some(e => e.topic || e.notes);
    }
    if (['Mindfulness', 'Recovery', 'Reflection'].includes(catName)) {
        const all = JSON.parse(Storage.getItem('journal_entries__' + catName.toLowerCase()) || '{}');
        const entries = all[getDateKey(viewDate)] || [];
        return entries.some(e => e.topic || e.notes);
    }
    if (catName === 'Mindset') {
        const all = JSON.parse(Storage.getItem('mindset_notes') || '{}');
        const datePrefix = getDateKey(viewDate) + '__';
        return Object.keys(all).some(k => k.startsWith(datePrefix) && all[k].trim() !== '');
    }
    if (catName === 'Mobility') {
        const datePrefix = getDateKey(viewDate) + '__';
        // Sets count as completion if any set is checked off (workout actually done today)
        const checks = JSON.parse(Storage.getItem('exercise_set_checks') || '{}');
        const hasChecks = Object.keys(checks).some(k =>
            k.startsWith(datePrefix) && (checks[k] || []).some(Boolean)
        );
        const simpleNotes = JSON.parse(Storage.getItem('mobility_simple_notes') || '{}');
        const hasSimple = Object.keys(simpleNotes).some(k =>
            k.startsWith(datePrefix) && simpleNotes[k].trim() !== ''
        );
        return hasChecks || hasSimple;
    }
    return false;
}

// Auto-bump completed categories that are still at the untouched default → 5.
// Returns true if any category changed (so we know to save).
function applyAutoBump() {
    let changed = false;
    categories.forEach(cat => {
        if (isCategoryCompleted(cat.name) && !cat.touched) {
            cat.value = 5;
            cat.touched = true;
            changed = true;
        }
    });
    return changed;
}

// Call after any data change that could affect category completion.
// Bumps + saves + re-renders the chart in one go.
function refreshChartAfterDataChange() {
    if (applyAutoBump()) saveDayData();
    initChart();
}

// Click-to-edit for titles. Replaces the element with an input on click,
// commits on Enter / blur, cancels on Escape.
//   titleEl  - the <h*> element to make editable
//   getValue - () => current raw string (NOT uppercased)
//   onSave   - (newValue) => void; called only if value changed and is non-empty.
//             onSave should perform any persistence; this helper handles
//             swapping the input back to the title element automatically.
function makeTitleEditable(titleEl, getValue, onSave) {
    if (!titleEl) return;
    titleEl.classList.add('editable-title');
    titleEl.style.cursor = 'text';

    titleEl.onclick = () => {
        const currentValue = getValue();
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'title-edit-input';
        input.value = currentValue;

        const parent = titleEl.parentNode;
        parent.replaceChild(input, titleEl);
        input.focus();
        input.select();

        let finished = false;
        const commit = (save) => {
            if (finished) return;
            finished = true;
            const newValue = input.value.trim();
            const shouldSave = save && newValue && newValue !== currentValue;
            // Always swap the title element back in first
            if (input.parentNode) input.parentNode.replaceChild(titleEl, input);
            if (shouldSave) {
                titleEl.textContent = newValue.toUpperCase();
                onSave(newValue);
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(true); }
            else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', () => commit(true));
    };
}

function loadDayData() {
    const key = getDateKey(viewDate);
    const savedData = Storage.getItem(STORAGE_KEY);
    const allData = savedData ? JSON.parse(savedData) : {};
    const dayData = allData[key] || {};


    let savedVitals = [];
    if (Array.isArray(dayData)) {
        savedVitals = dayData;
        avoidedToday = [];
    } else {
        savedVitals = dayData.vitals || [];
        avoidedToday = dayData.avoided || [];
    }


    categories = defaultValues.map((def, idx) => {
        const saved = savedVitals[idx] || {};
        // "touched" means the user has interacted with this dot. We use the
        // presence of a saved value as a signal that they touched it before
        // (or that auto-bump fired, which we treat as touched too once committed).
        const wasSaved = saved.value !== undefined;
        return {
            name: def.name,
            value: wasSaved ? saved.value : def.value,
            note: saved.note !== undefined ? saved.note : def.note,
            touched: wasSaved
        };
    });

    if (applyAutoBump()) saveDayData();

    updateDateDisplay();
    initChart();
    renderSinsMixer();
}

function saveDayData() {
    const key = getDateKey(viewDate);
    const savedData = Storage.getItem(STORAGE_KEY);
    const allData = savedData ? JSON.parse(savedData) : {};

    allData[key] = {
        vitals: categories,
        avoided: avoidedToday
    };
    Storage.setItem(STORAGE_KEY, JSON.stringify(allData));
}

function updateDateDisplay() {
    const today = new Date();
    const isToday = getDateKey(viewDate) === getDateKey(today);
    const dayLabel = document.getElementById('day-name');
    const dateLabel = document.getElementById('full-date');

    if (dayLabel) dayLabel.textContent = isToday ? "TODAY" : viewDate.toLocaleDateString('en-US', { weekday: 'long' });
    if (dateLabel) dateLabel.textContent = viewDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function getCoords(index, value) {
    const angle = (Math.PI * 2 / categories.length) * index - Math.PI / 2;
    const r = (value / maxValue) * radius;
    return {
        x: centerX + r * Math.cos(angle),
        y: centerY + r * Math.sin(angle),
        angle: angle
    };
}


function initChart() {
    svg.innerHTML = '';
    createGrid();
    render();
    requestAnimationFrame(drawWedges);
}

function createGrid() {

    for (let i = 1; i <= 5; i++) {
        const r = (radius / 5) * i;
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", centerX);
        circle.setAttribute("cy", centerY);
        circle.setAttribute("r", r);
        circle.setAttribute("class", "grid-line");
        circle.setAttribute("fill", "none");
        if (i === 5) circle.style.stroke = "rgba(201,169,110,0.2)";
        svg.appendChild(circle);
    }


    categories.forEach((cat, i) => {
        const outer = getCoords(i, maxValue);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", centerX); line.setAttribute("y1", centerY);
        line.setAttribute("x2", outer.x); line.setAttribute("y2", outer.y);
        line.setAttribute("class", "grid-line");
        svg.appendChild(line);


        // Label distance from center. maxValue is 10 (the outer ring of the chart),
        // so adding to it pushes labels OUTSIDE the chart. Lower value = closer to center.
        // Was maxValue + 3, now maxValue + 1.5 for tighter labels.
        const labelDistance = maxValue + 1.5;
        const labelPos = getCoords(i, labelDistance);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", labelPos.x);
        text.setAttribute("y", labelPos.y);


        const hasNote = isCategoryCompleted(cat.name);


        text.setAttribute("class", hasNote ? "axis-label has-note" : "axis-label");

        text.textContent = cat.name.toUpperCase();
        text.onclick = () => openNoteModal(i);


        const xOff = Math.cos(outer.angle);
        const yOff = Math.sin(outer.angle);
        text.setAttribute("text-anchor", Math.abs(xOff) < 0.1 ? "middle" : (xOff > 0 ? "start" : "end"));
        text.setAttribute("dominant-baseline", Math.abs(yOff) < 0.1 ? "middle" : (yOff > 0 ? "hanging" : "alphabetic"));

        svg.appendChild(text);
    });
}

function render() {
    const old = svg.querySelectorAll('.polygon-fill, .handle-group');
    old.forEach(el => el.remove());

    const points = categories.map((cat, i) => {
        const p = getCoords(i, cat.value);
        return `${p.x},${p.y}`;
    }).join(' ');


    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", points);
    poly.setAttribute("class", "polygon-fill");
    svg.appendChild(poly);


    categories.forEach((cat, i) => {
        const p = getCoords(i, cat.value);
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.setAttribute("class", "handle-group");

        const hitbox = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        hitbox.setAttribute("cx", p.x); hitbox.setAttribute("cy", p.y);
        hitbox.setAttribute("r", 36); hitbox.setAttribute("class", "handle-hitbox");

        const visualDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        visualDot.setAttribute("cx", p.x); visualDot.setAttribute("cy", p.y);
        visualDot.setAttribute("r", 4); visualDot.setAttribute("class", "handle");

        // Glow proportional to value: 0 = no glow, 10 = strong glow
        const glowFraction = cat.value / maxValue;
        const blurRadius = 2 + glowFraction * 12;       // 2 → 14
        const opacity = 0.15 + glowFraction * 0.85;     // 0.15 → 1.0
        visualDot.style.filter = `drop-shadow(0 0 ${blurRadius}px rgba(201,169,110,${opacity}))`;


        const percentage = Math.round(cat.value);
        const labelText = document.createElementNS("http://www.w3.org/2000/svg", "text");


        const offset = 14;
        const angle = (Math.PI * 2 / categories.length) * i - Math.PI / 2;


        const labelX = p.x + Math.cos(angle) * offset;
        const labelY = p.y + Math.sin(angle) * offset;

        labelText.setAttribute("x", labelX);
        labelText.setAttribute("y", labelY);
        labelText.setAttribute("class", "value-label");


        const xOff = Math.cos(angle);
        const yOff = Math.sin(angle);


        if (Math.abs(xOff) < 0.1) {
            labelText.setAttribute("text-anchor", "middle");
        } else {
            labelText.setAttribute("text-anchor", xOff > 0 ? "start" : "end");
        }


        if (Math.abs(yOff) < 0.1) {
            labelText.setAttribute("dominant-baseline", "middle");
        } else {
            labelText.setAttribute("dominant-baseline", yOff > 0 ? "hanging" : "alphabetic");
        }

        labelText.textContent = `${percentage}`;
        // Hide the number when (a) the user hasn't touched the dot yet, so the
        // default value doesn't clutter the chart, or (b) the value is 0.
        // Showing it requires any interaction — drag or tap, even back to default.
        if (!cat.touched || percentage === 0) labelText.style.display = 'none';

        // Hitboxes are kept (so the cursor: grab from CSS still works on
        // hover), but the actual click→drag routing happens at the SVG level
        // below. With 6 handles on a tight circle, the 36px hitboxes overlap
        // heavily — and SVG hit-testing prefers later siblings, so the
        // "wrong" (next) handle was winning. Picking nearest-by-distance
        // fixes that.

        group.appendChild(hitbox);
        group.appendChild(visualDot);
        group.appendChild(labelText);
        svg.appendChild(group);
    });


}

// Single SVG-wide pointerdown that picks the NEAREST handle to the click.
// Set up once at script load — kept outside render() so we don't pile up
// duplicate listeners every time the chart redraws.
svg.addEventListener('pointerdown', (e) => {
    // Convert click point to SVG coords for accurate distance comparisons
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const p = pt.matrixTransform(ctm.inverse());

    // Find the closest handle within a max distance threshold (36 SVG units —
    // matches the original hitbox radius, so the click area feels the same).
    let bestIdx = -1;
    let bestDist = 36;
    categories.forEach((cat, i) => {
        const c = getCoords(i, cat.value);
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    });

    if (bestIdx !== -1) {
        startDrag(e, bestIdx);
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
        modal.style.display = 'none';
    }
});


function startDrag(e, index) {
    e.preventDefault();
    e.stopPropagation();
    isDragging = false; // will become true on first move
    currentHandleIdx = index;
    _dragStartX = e.clientX;
    _dragStartY = e.clientY;
    _dragMoved = false;
    _activePointerId = e.pointerId;
    // Capture so we keep getting events even if the finger leaves the hitbox
    if (e.target.setPointerCapture) {
        try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    }
    document.body.style.cursor = 'grabbing';
    window.addEventListener('pointermove', drag, {passive: false});
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
}

let _dragStartX = 0, _dragStartY = 0, _dragMoved = false, _activePointerId = null;

function drag(e) {
    if (currentHandleIdx === null) return;
    if (_activePointerId !== null && e.pointerId !== _activePointerId) return;
    e.preventDefault();
    const clientX = e.clientX;
    const clientY = e.clientY;

    // Bigger threshold on touch devices (pointerType === 'touch') because fingers
    // jiggle more than a mouse. Prevents tap-from-becoming-drag misfires on mobile.
    if (!_dragMoved) {
        const threshold = e.pointerType === 'touch' ? 8 : 4;
        const dist = Math.sqrt(Math.pow(clientX - _dragStartX, 2) + Math.pow(clientY - _dragStartY, 2));
        if (dist < threshold) return;
        _dragMoved = true;
        isDragging = true;
    }

    // Convert client (screen) coords → SVG viewBox coords correctly.
    // The previous version assumed a square 1:1 mapping from rect → viewBox,
    // but with viewBox="0 0 400 400", overflow:visible labels, and any non-square
    // rendered size, that's wrong — the result was that clicking one dot would
    // drag the neighboring one. Using createSVGPoint().matrixTransform() with the
    // inverse screen-CTM gives the exact viewBox coords regardless of size or
    // aspect ratio.
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgPoint = pt.matrixTransform(ctm.inverse());
    const svgX = svgPoint.x;
    const svgY = svgPoint.y;

    const angle = (Math.PI * 2 / categories.length) * currentHandleIdx - Math.PI / 2;
    const dx = svgX - centerX;
    const dy = svgY - centerY;

    const projectedDist = dx * Math.cos(angle) + dy * Math.sin(angle);
    let newValue = (projectedDist / radius) * maxValue;

    categories[currentHandleIdx].value = Math.min(Math.max(Math.round(newValue), 0), maxValue);
    categories[currentHandleIdx].touched = true;

    render();
    saveDayData();
}

function stopDrag(e) {
    if (_activePointerId !== null && e && e.pointerId !== _activePointerId) return;
    // If barely moved, treat as a tap → increment value (wraps 0→10→0)
    if (!_dragMoved && currentHandleIdx !== null) {
        const cat = categories[currentHandleIdx];
        cat.value = cat.value >= maxValue ? 0 : cat.value + 1;
        cat.touched = true;
        render();
        saveDayData();
    }
    isDragging = false;
    _dragMoved = false;
    currentHandleIdx = null;
    _activePointerId = null;
    document.body.style.cursor = 'default';
    window.removeEventListener('pointermove', drag);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
}


document.getElementById('prevDay').addEventListener('click', () => {
    viewDate.setDate(viewDate.getDate() - 1);
    loadDayData();
});

document.getElementById('nextDay').addEventListener('click', () => {
    viewDate.setDate(viewDate.getDate() + 1);
    loadDayData();
});


loadDayData();                              // render immediately with defaults
_loadFromJsonBin().then(() => loadDayData()); // re-render once remote data arrives


function drawWedges() {
    const radarSvg = document.getElementById('radarChart');
    const rect = radarSvg.getBoundingClientRect();


    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    const colors = [
        '#070706',
        '#090908',
        '#070706',
        '#090908',
        '#070706',
        '#090908',
    ];

    const offset = 270;
    const stops = [];
    colors.forEach((color, i) => {
        const start = i * 60;
        const end = start + 60;
        stops.push(`${color} ${start}deg`);
        stops.push(`${color} ${end}deg`);
    });

    stops.push(`${colors[0]} 360deg`);

    let bg = document.getElementById('wedge-bg');
    if (!bg) {
        bg = document.createElement('div');
        bg.id = 'wedge-bg';
        bg.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;';
        document.body.prepend(bg);
    }
    bg.style.background = `conic-gradient(from ${offset}deg at ${cx}px ${cy}px, ${stops.join(', ')})`;
}


requestAnimationFrame(() => requestAnimationFrame(drawWedges));
window.addEventListener('resize', drawWedges);
window.addEventListener('load', () => requestAnimationFrame(drawWedges));

const modal = document.getElementById('calendarModal');
const calendarGrid = document.getElementById('calendarGrid');
let calendarDate = new Date();


document.getElementById('full-date').addEventListener('click', () => {
    calendarDate = new Date(viewDate);
    renderCalendar();
    modal.style.display = 'flex';
});


document.getElementById('closeModal').addEventListener('click', () => modal.style.display = 'none');


function renderCalendar() {
    calendarGrid.innerHTML = '';
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();

    document.getElementById('monthYearLabel').textContent =
        calendarDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const firstDayIndex = new Date(year, month, 1).getDay();
    const daysInCurrentMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthLastDay = new Date(year, month, 0).getDate();


    for (let i = 0; i < 42; i++) {
        const div = document.createElement('div');
        div.className = 'day-box';

        let dayNumber;

        if (i < firstDayIndex) {

            dayNumber = prevMonthLastDay - firstDayIndex + i + 1;
            div.textContent = dayNumber;
            div.classList.add('other-month');
        } else if (i >= firstDayIndex + daysInCurrentMonth) {

            dayNumber = i - (firstDayIndex + daysInCurrentMonth) + 1;
            div.textContent = dayNumber;
            div.classList.add('other-month');
        } else {

            dayNumber = i - firstDayIndex + 1;
            div.textContent = dayNumber;

            if (dayNumber === viewDate.getDate() &&
                month === viewDate.getMonth() &&
                year === viewDate.getFullYear()) {
                div.classList.add('current');
            }

            div.onclick = () => {
                viewDate = new Date(year, month, dayNumber);
                loadDayData();
                modal.style.display = 'none';
            };
        }
        calendarGrid.appendChild(div);
    }
}


document.getElementById('prevMonth').onclick = () => {
    calendarDate.setMonth(calendarDate.getMonth() - 1);
    renderCalendar();
};
document.getElementById('nextMonth').onclick = () => {
    calendarDate.setMonth(calendarDate.getMonth() + 1);
    renderCalendar();
};

const noteModal = document.getElementById('noteModal');
const noteArea = document.getElementById('noteArea');
const noteTitle = document.getElementById('noteTitle');
let activeNoteIdx = null;

function openNoteModal(index) {
    const cat = categories[index];
    if (cat.name === 'Mobility') { openExerciseModal(); return; }
    if (cat.name === 'Spirituality') { openSpiritualModal(); return; }
    if (cat.name === 'Mindfulness') { openJournalModal('mindfulness'); return; }
    if (cat.name === 'Recovery') { openJournalModal('recovery'); return; }
    if (cat.name === 'Reflection') { openJournalModal('reflection'); return; }
    if (cat.name === 'Mindset') { openMindsetModal(); return; }
    activeNoteIdx = index;
    noteTitle.textContent = cat.name.toUpperCase() + " NOTES";
    noteArea.value = cat.note || "";
    noteModal.style.display = 'flex';
    setTimeout(() => noteArea.focus(), 50);
}

document.getElementById('saveNote').onclick = () => {
    if (activeNoteIdx !== null) {

        categories[activeNoteIdx].note = noteArea.value;
        saveDayData();


        refreshChartAfterDataChange();

        noteModal.style.display = 'none';
        activeNoteIdx = null;
    }
};

document.getElementById('closeNoteModal').onclick = () => {
    noteModal.style.display = 'none';
    activeNoteIdx = null;
};


window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        modal.style.display = 'none';
        noteModal.style.display = 'none';
    }
});

function renderSinsMixer(opts) {
    const container = document.getElementById('sins-mixer');
    if (!container) return;

    const animateFrom = opts && opts.animateFrom; // 'sins' | 'virtues' | undefined
    const mode = getMixerMode();
    const cfg = getMixerConfig(mode);
    const levels = getLevelsForDay(cfg.levelsKey);
    const entries = getAllLevels(cfg.entriesKey);

    // Tag the container so CSS can theme based on mode if we ever want to
    container.dataset.mode = mode;

    container.innerHTML = '';

    cfg.list.forEach(activity => {
        const slot = document.createElement('div');
        slot.className = 'sin-slot';

        // Note exists for this activity today?
        // Supports both new format ({ notes }) and old format ({ happened, learned }).
        const entryKey = getDateKey(viewDate) + '__' + activity;
        const entry = entries[entryKey];
        const hasNote = !!entry && (entry.notes || entry.happened || entry.learned);

        // Label (click → opens note modal). When a note exists for today,
        // CSS underlines the label via the .has-note class.
        const label = document.createElement('span');
        label.className = hasNote ? 'sin-label has-note' : 'sin-label';
        // Sins are short already; virtues get truncated to 5 chars + "." so
        // the long ones (Knowledge, Integrity, Patience…) don't squeeze the
        // slot or wrap to two lines.
        label.textContent = mode === 'virtues' && activity.length > 5
            ? activity.slice(0, 5) + '.'
            : activity;
        label.onclick = () => openAvoidedModal(activity);

        // Slider assembly: wrap > track (with fill inside) + thumb.
        const wrap = document.createElement('div');
        wrap.className = 'sin-slider-wrap';

        const track = document.createElement('div');
        track.className = 'sin-slider-track';

        const fill = document.createElement('div');
        fill.className = 'sin-slider-fill';
        track.appendChild(fill);

        const thumb = document.createElement('div');
        thumb.className = 'sin-slider-thumb';

        const valueText = document.createElement('span');
        valueText.className = 'sin-value';

        let currentValue = parseInt(levels[activity] || 0, 10);

        // Sync visuals to the current value.
        const sync = () => {
            const pct = (currentValue / 10) * 100;
            fill.style.height = pct + '%';

            const wrapH = wrap.clientHeight || 100;
            const inset = 8;
            const thumbH = 5;
            const usable = wrapH - inset * 2;
            const fillTopPx = inset + (currentValue / 10) * usable;
            thumb.style.bottom = (fillTopPx - thumbH / 2) + 'px';

            const isOn = currentValue > 0;
            track.classList.toggle('has-value', isOn);
            thumb.classList.toggle('has-value', isOn);
            valueText.classList.toggle('has-value', isOn);
            valueText.textContent = isOn ? String(currentValue) : '\u00A0';
        };

        // Pointer-based drag — relative-delta, so clicks don't snap the thumb.
        // Each slider checks the shared swipe flag (set by the container-level
        // swipe detector) and bails out if a horizontal swipe is in progress,
        // reverting any value change it made.
        let dragging = false;
        let startClientY = 0;
        let startClientX = 0;
        let startValue = 0;

        const onPointerDown = (e) => {
            e.preventDefault();
            dragging = true;
            startClientY = e.clientY;
            startClientX = e.clientX;
            startValue = currentValue;
            wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId);
        };
        const onPointerMove = (e) => {
            if (!dragging) return;

            // If a swipe was just declared, abort: revert the value to what it
            // was at gesture start, release capture so the swipe handler gets
            // the rest of the gesture, and stop tracking.
            if (window.__mixerSwipeActive) {
                if (currentValue !== startValue) {
                    currentValue = startValue;
                    setLevel(cfg.levelsKey, activity, startValue);
                    sync();
                }
                dragging = false;
                try { wrap.releasePointerCapture && wrap.releasePointerCapture(e.pointerId); } catch (_) {}
                return;
            }

            e.preventDefault();
            const rect = wrap.getBoundingClientRect();
            const inset = 8;
            const usable = rect.height - inset * 2;
            const deltaY = startClientY - e.clientY;
            const deltaValue = Math.round((deltaY / usable) * 10);
            let v = startValue + deltaValue;
            v = Math.max(0, Math.min(10, v));
            if (v !== currentValue) {
                currentValue = v;
                setLevel(cfg.levelsKey, activity, v);
                sync();
            }
        };
        const onPointerUp = (e) => {
            if (!dragging) return;
            dragging = false;
            try { wrap.releasePointerCapture && wrap.releasePointerCapture(e.pointerId); } catch (_) {}
        };

        wrap.addEventListener('pointerdown', onPointerDown);
        wrap.addEventListener('pointermove', onPointerMove);
        wrap.addEventListener('pointerup', onPointerUp);
        wrap.addEventListener('pointercancel', onPointerUp);

        wrap.appendChild(track);
        wrap.appendChild(thumb);

        slot.appendChild(label);
        slot.appendChild(wrap);
        slot.appendChild(valueText);
        container.appendChild(slot);

        sync();
    });

    // ─── Entry animation on mode switch ────────────────────────────
    // When toggling between sins/virtues, slide the whole row in from the
    // side opposite the swipe direction. Direction is passed through as
    // 'left' or 'right' (the swipe direction); the new row enters from
    // the opposite side.
    if (animateFrom) {
        const slideDir = animateFrom === 'left' ? -1 : 1;
        container.style.setProperty('--slide-dir', slideDir);
        container.classList.add('mixer-row-enter');
        container.addEventListener('animationend', () => {
            container.classList.remove('mixer-row-enter');
            container.style.removeProperty('--slide-dir');
        }, { once: true });
    }

    // ─── Swipe-to-switch ────────────────────────────────────────────
    // Set up once. Detects horizontal-dominant gestures anywhere on the
    // slider row. Sets a global flag so individual sliders can abort
    // their vertical-drag handling and revert any half-applied value.
    if (!container.__swipeBound) {
        container.__swipeBound = true;
        const SWIPE_THRESHOLD = 40;     // px of horizontal travel to commit a switch
        const DECISION_THRESHOLD = 12;  // px of motion before we decide direction

        let startX = 0, startY = 0;
        let tracking = false;
        let decided = false; // 'horizontal' | 'vertical' | false

        container.addEventListener('pointerdown', (e) => {
            tracking = true;
            decided = false;
            window.__mixerSwipeActive = false;
            startX = e.clientX;
            startY = e.clientY;
        });

        container.addEventListener('pointermove', (e) => {
            if (!tracking) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!decided) {
                // Wait until the gesture moves enough to classify it.
                if (Math.abs(dx) < DECISION_THRESHOLD && Math.abs(dy) < DECISION_THRESHOLD) return;
                decided = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
                if (decided === 'horizontal') {
                    window.__mixerSwipeActive = true;
                }
            }
        });

        const endSwipe = (e) => {
            if (!tracking) return;
            const wasHorizontal = decided === 'horizontal';
            tracking = false;
            decided = false;
            if (!wasHorizontal) {
                window.__mixerSwipeActive = false;
                return;
            }
            const dx = e.clientX - startX;
            const currentMode = getMixerMode();
            // Either direction switches — there are only two modes, so swipe
            // direction is purely conventional. We just toggle on any
            // horizontal swipe past the threshold.
            if (Math.abs(dx) >= SWIPE_THRESHOLD) {
                const nextMode = currentMode === 'sins' ? 'virtues' : 'sins';
                // Swipe direction drives the slide: dx<0 = left swipe → row
                // exits to the left, new row enters from the right.
                const swipeDir = dx < 0 ? 'left' : 'right';
                const slideDir = swipeDir === 'left' ? -1 : 1;
                container.style.setProperty('--slide-dir', slideDir);
                container.classList.add('mixer-row-exit');
                const onExitEnd = () => {
                    container.classList.remove('mixer-row-exit');
                    setMixerMode(nextMode);
                    renderSinsMixer({ animateFrom: swipeDir });
                };
                container.addEventListener('animationend', onExitEnd, { once: true });
            }
            // Reset the flag *after* the render so any in-flight slider
            // pointermove (about to bail) still sees true.
            setTimeout(() => { window.__mixerSwipeActive = false; }, 0);
        };

        container.addEventListener('pointerup', endSwipe);
        container.addEventListener('pointercancel', endSwipe);
        container.addEventListener('pointerleave', (e) => {
            // If the pointer leaves the row mid-swipe without an up event
            // (rare, but possible on edge cases), treat it as the end.
            if (tracking) endSwipe(e);
        });
    }
}

const EXERCISE_LIBRARY_KEY = 'exercise_library';
const EXERCISE_LOGS_KEY = 'exercise_logs';
const EXERCISE_CHECKS_KEY = 'exercise_set_checks';
const EXERCISE_NOTES_KEY = 'exercise_notes';

const muscleGroups = ['Triceps', 'Biceps', 'Shoulders', 'Chest', 'Back', 'Abs'];
let activeMuscle = null;
let activeExercise = null;


function getMasterLibrary() {
    const raw = Storage.getItem(EXERCISE_LIBRARY_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveMasterLibrary(lib) {
    Storage.setItem(EXERCISE_LIBRARY_KEY, JSON.stringify(lib));
}


function getDayLibraryKey(date) {
    return `exercise_library__${getDateKey(date)}`;
}

// Returns the most recent prior day (within 365 days) that has a library
// snapshot, so newly opened days inherit yesterday's exercise list.
function findMostRecentLibrary() {
    const probe = new Date(viewDate);
    for (let i = 0; i < 365; i++) {
        probe.setDate(probe.getDate() - 1);
        const raw = Storage.getItem(`exercise_library__${getDateKey(probe)}`);
        if (raw) return JSON.parse(raw);
    }
    return null;
}

function getExerciseLibrary() {
    const dayKey = getDayLibraryKey(viewDate);
    const dayRaw = Storage.getItem(dayKey);
    if (dayRaw) {
        return JSON.parse(dayRaw);
    }
    // No snapshot for today → inherit yesterday's (or the master if first time)
    const inherited = findMostRecentLibrary() || getMasterLibrary();
    Storage.setItem(dayKey, JSON.stringify(inherited));
    return inherited;
}
function saveExerciseLibrary(lib) {

    Storage.setItem(getDayLibraryKey(viewDate), JSON.stringify(lib));
}
function getExerciseLogs() {
    const raw = Storage.getItem(EXERCISE_LOGS_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveExerciseLogs(logs) {
    Storage.setItem(EXERCISE_LOGS_KEY, JSON.stringify(logs));
}
function getDayLogKey(muscle, exercise) {
    return `${getDateKey(viewDate)}__${muscle}__${exercise}`;
}

// Returns the most recent prior day's set log for this muscle+exercise, used
// as a default when the current day has no log yet. Walks back up to 365 days.
function getInheritedLog(muscle, exercise) {
    const logs = getExerciseLogs();
    const probe = new Date(viewDate);
    for (let i = 0; i < 365; i++) {
        probe.setDate(probe.getDate() - 1);
        const key = `${getDateKey(probe)}__${muscle}__${exercise}`;
        if (logs[key]) return logs[key];
    }
    return null;
}

// Per-day checked-state for sets. Each value is an array of booleans, one per set.
function getExerciseChecks() {
    const raw = Storage.getItem(EXERCISE_CHECKS_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveExerciseChecks(checks) {
    Storage.setItem(EXERCISE_CHECKS_KEY, JSON.stringify(checks));
}

// Per-exercise notes — keyed by muscle+exercise, NOT per-day. Notes are
// considered persistent guidance for the exercise itself, so they carry over.
function getExerciseNotes() {
    const raw = Storage.getItem(EXERCISE_NOTES_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveExerciseNotes(notes) {
    Storage.setItem(EXERCISE_NOTES_KEY, JSON.stringify(notes));
}
function getExerciseNoteKey(muscle, exercise) {
    return `${muscle}__${exercise}`;
}


function showExScreen(id) {
    ['ex-screen-muscles','ex-screen-exercises','ex-screen-sets','ex-screen-simple','ex-screen-ex-notes'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

const MOBILITY_EXTRAS = ['Yoga', 'Posture'];
const MOBILITY_SIMPLE_KEY = 'mobility_simple_notes';

function getMobilitySimpleNotes() {
    const raw = Storage.getItem(MOBILITY_SIMPLE_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveMobilitySimpleNotes(notes) {
    Storage.setItem(MOBILITY_SIMPLE_KEY, JSON.stringify(notes));
}
function getMobilitySimpleKey(type) {
    return getDateKey(viewDate) + '__' + type;
}


function openExerciseModal() {
    renderMuscleGrid();
    showExScreen('ex-screen-muscles');
    document.getElementById('exerciseModal').style.display = 'flex';
}

function renderMuscleGrid() {
    const grid = document.getElementById('muscle-grid');
    grid.innerHTML = '';
    const checks = getExerciseChecks();
    const datePrefix = getDateKey(viewDate) + '__';

    muscleGroups.forEach(muscle => {
        const btn = document.createElement('button');
        btn.className = 'muscle-btn';
        // A muscle group counts as "done today" if any set was checked off today
        const hasData = Object.keys(checks).some(k =>
            k.startsWith(datePrefix + muscle + '__') &&
            (checks[k] || []).some(Boolean)
        );
        if (hasData) btn.classList.add('has-data');
        btn.textContent = muscle.toUpperCase();
        btn.onclick = () => openMuscleScreen(muscle);
        grid.appendChild(btn);
    });


    const extras = document.getElementById('mobility-extras');
    extras.innerHTML = '';
    const simpleNotes = getMobilitySimpleNotes();
    MOBILITY_EXTRAS.forEach(type => {
        const btn = document.createElement('button');
        btn.className = 'muscle-btn';
        const noteKey = getMobilitySimpleKey(type);
        // Yoga/Posture are now boolean toggles instead of note-opening buttons.
        // Any truthy value (including legacy free-text notes) counts as "done".
        const isDone = !!(simpleNotes[noteKey] && String(simpleNotes[noteKey]).trim());
        if (isDone) btn.classList.add('has-data');
        btn.textContent = type.toUpperCase();
        btn.onclick = () => toggleMobilityExtra(type);
        extras.appendChild(btn);
    });
}

// Toggle a mobility extra (Yoga / Posture) on or off for the current day.
// '1' means done; deleting the key means not done. We store under the same
// key the old notes feature used so historical "done" days carry over.
function toggleMobilityExtra(type) {
    const notes = getMobilitySimpleNotes();
    const key = getMobilitySimpleKey(type);
    const wasDone = !!(notes[key] && String(notes[key]).trim());
    if (wasDone) {
        delete notes[key];
    } else {
        notes[key] = '1';
    }
    saveMobilitySimpleNotes(notes);
    refreshChartAfterDataChange();
    renderMuscleGrid();
}

// Legacy openSimpleScreen / save handler are no longer reachable from the
// muscle grid (Yoga/Posture toggle in place now), but the screen itself
// stays in the DOM in case some other code path opens it. We leave the
// open/save functions in place defensively.
function openSimpleScreen(type) {
    document.getElementById('ex-simple-title').textContent = type.toUpperCase();
    const notes = getMobilitySimpleNotes();
    document.getElementById('exSimpleNotes').value = notes[getMobilitySimpleKey(type)] || '';
    showExScreen('ex-screen-simple');
    setTimeout(() => document.getElementById('exSimpleNotes').focus(), 50);
}

document.getElementById('exBackToMusclesSimple').onclick = () => {
    renderMuscleGrid();
    showExScreen('ex-screen-muscles');
};

document.getElementById('exSimpleSaveBtn').onclick = () => {
    const titleEl = document.getElementById('ex-simple-title').textContent;

    const type = MOBILITY_EXTRAS.find(t => t.toUpperCase() === titleEl) || titleEl;
    const notes = getMobilitySimpleNotes();
    notes[getMobilitySimpleKey(type)] = document.getElementById('exSimpleNotes').value.trim();
    saveMobilitySimpleNotes(notes);
    refreshChartAfterDataChange();
    renderMuscleGrid();
    showExScreen('ex-screen-muscles');
};

document.getElementById('closeExerciseModal4').onclick = () => {
    document.getElementById('exerciseModal').style.display = 'none';
};

function openMuscleScreen(muscle) {
    activeMuscle = muscle;
    document.getElementById('ex-muscle-title').textContent = muscle.toUpperCase();
    renderExerciseList();
    showExScreen('ex-screen-exercises');
}

function renderExerciseList() {
    const list = document.getElementById('exercise-list');
    list.innerHTML = '';
    const library = getExerciseLibrary();
    const exercises = library[activeMuscle] || [];
    const logs = getExerciseLogs();
    const checks = getExerciseChecks();

    if (exercises.length === 0) {
        list.innerHTML = '<p class="empty-state">No exercises yet. Add one below.</p>';
        return;
    }

    exercises.forEach((ex, idx) => {
        const logKey = getDayLogKey(activeMuscle, ex);
        // Display weights from today if logged, otherwise inherit from the
        // most recent prior day so the user sees their last numbers.
        const sets = logs[logKey] || getInheritedLog(activeMuscle, ex);
        // "has-data" is now driven by today's checks (workout actually done today)
        const todaysChecks = checks[logKey] || [];
        const isDoneToday = todaysChecks.some(Boolean);

        const row = document.createElement('div');
        row.className = isDoneToday ? 'exercise-row has-data' : 'exercise-row';
        row.dataset.idx = idx;

        const name = document.createElement('span');
        name.className = 'exercise-row-name';
        name.textContent = ex;

        const meta = document.createElement('span');
        meta.className = 'exercise-row-meta';
        if (sets && sets.some(s => s.weight || s.reps)) {
            meta.textContent = sets.filter(s => s.weight || s.reps)
                .map(s => `${s.weight||'?'}kg × ${s.reps||'?'}`)
                .join('  ');
        }

        const del = document.createElement('button');
        del.className = 'exercise-delete-btn';
        del.textContent = '×';
        del.title = 'Remove exercise';
        del.onclick = (e) => {
            e.stopPropagation();
            deleteExercise(ex);
        };

        row.appendChild(name);
        row.appendChild(meta);
        row.appendChild(del);

        // Drag-to-reorder: long-press on touch, regular drag on mouse.
        // Tap (without drag) still opens the sets screen via the click handler below.
        attachExerciseDragHandlers(row, ex);

        list.appendChild(row);
    });
}

// ─── Exercise drag-to-reorder ────────────────────────────────────────
// Long-press (350ms) on touch or immediate drag on mouse to grab a row.
// Click (no drag) still opens the sets screen.
// The dragged row visually "lifts" and follows the pointer; the other rows
// reflow live underneath so you can see exactly where it'll land before drop.
let _exDrag = null; // null when not dragging; otherwise an object with state

function attachExerciseDragHandlers(row, exerciseName) {
    let longPressTimer = null;
    let startX = 0, startY = 0;
    let pointerDownTime = 0;
    let activePointerId = null;
    let dragArmed = false; // becomes true once long-press fires (touch) or move threshold passes (mouse)

    const cleanupTimer = () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        row.classList.remove('long-pressing');
    };

    const onPointerDown = (e) => {
        // Ignore right-click and the delete button
        if (e.button === 2) return;
        if (e.target.classList.contains('exercise-delete-btn')) return;

        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        pointerDownTime = Date.now();
        dragArmed = false;

        if (e.pointerType === 'touch') {
            // On touch: arm a long-press timer. While armed, we don't drag yet.
            row.classList.add('long-pressing');
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                row.classList.remove('long-pressing');
                dragArmed = true;
                beginDrag();
                if (navigator.vibrate) navigator.vibrate(15);
            }, 350);
        }

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
    };

    const beginDrag = () => {
        const list = document.getElementById('exercise-list');
        const rect = row.getBoundingClientRect();

        // Snapshot every row's current top before we lift anything, so we can
        // animate them with FLIP later when their positions change.
        const otherRows = Array.from(list.querySelectorAll('.exercise-row'))
            .filter(r => r !== row);

        _exDrag = {
            row,
            list,
            otherRows,
            rowHeight: rect.height,
            // Where on the row the pointer grabbed it (relative to row top).
            // We preserve this offset throughout the drag so the row doesn't
            // jump under the cursor when the DOM reorders.
            grabOffsetY: startY - rect.top,
            currentBeforeRow: null,
        };

        // Mark the row as the floating one. CSS handles the visual lift.
        row.classList.add('dragging');
        try { row.setPointerCapture(activePointerId); } catch (e) {}
    };

    const onPointerMove = (e) => {
        if (e.pointerId !== activePointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // On touch: any move > 8px before long-press fires cancels the long-press
        // (treats it as a scroll attempt instead of a drag).
        if (e.pointerType === 'touch' && longPressTimer && dist > 8) {
            cleanupTimer();
            return;
        }

        // On mouse: start dragging once we've moved past 5px.
        if (e.pointerType !== 'touch' && !dragArmed && dist > 5) {
            dragArmed = true;
            beginDrag();
        }

        if (!dragArmed || !_exDrag) return;

        e.preventDefault();

        const pointerY = e.clientY;
        const list = _exDrag.list;

        // Helper: anchor the dragged row so the cursor stays at the same spot
        // on it as where the user originally grabbed. We compute against the
        // row's CURRENT natural layout position (without its own transform),
        // which works correctly even after DOM reorders.
        const anchorToPointer = () => {
            // Temporarily remove transform to read the row's natural position
            const prev = _exDrag.row.style.transform;
            _exDrag.row.style.transform = '';
            const naturalTop = _exDrag.row.getBoundingClientRect().top;
            const desiredTop = pointerY - _exDrag.grabOffsetY;
            _exDrag.row.style.transform = `translateY(${desiredTop - naturalTop}px)`;
        };

        // First, anchor the row to the pointer at its current DOM position.
        anchorToPointer();

        // Figure out which other-row's vertical midpoint the pointer is past,
        // and swap the dragged row in front of it.
        let insertBefore = null; // null → append at end
        for (const other of _exDrag.otherRows) {
            const r = other.getBoundingClientRect();
            const mid = r.top + r.height / 2;
            if (pointerY < mid) {
                insertBefore = other;
                break;
            }
        }

        if (insertBefore !== _exDrag.currentBeforeRow) {
            // FLIP: capture old positions of the OTHER rows (the ones that will
            // shift), move the dragged row in the DOM, then animate them from
            // their old positions to their new ones.
            const movedRows = _exDrag.otherRows;
            // Clear any leftover transforms before measuring so we get true
            // layout positions, not animation-in-progress positions.
            movedRows.forEach(r => { r.style.transition = 'none'; r.style.transform = ''; });
            const firstRects = movedRows.map(r => r.getBoundingClientRect());

            // Move the dragged row in the DOM. Its transform stays — anchorToPointer
            // will be called again right after to re-anchor based on new position.
            if (insertBefore) {
                list.insertBefore(_exDrag.row, insertBefore);
            } else {
                list.appendChild(_exDrag.row);
            }
            _exDrag.currentBeforeRow = insertBefore;

            // Re-anchor the dragged row to the pointer at its new DOM home.
            anchorToPointer();

            // Animate the other rows from their old layout positions to their new ones.
            movedRows.forEach((r, i) => {
                const last = r.getBoundingClientRect();
                const delta = firstRects[i].top - last.top;
                if (delta) {
                    r.style.transition = 'none';
                    r.style.transform = `translateY(${delta}px)`;
                    requestAnimationFrame(() => {
                        r.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
                        r.style.transform = '';
                    });
                }
            });
        }
    };

    const onPointerUp = (e) => {
        if (e.pointerId !== activePointerId) return;
        cleanupTimer();
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);

        const wasDragging = !!_exDrag;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const elapsed = Date.now() - pointerDownTime;

        if (wasDragging) {
            // The DOM is already in the new order — read it back and persist.
            const list = _exDrag.list;
            const finalOrder = Array.from(list.querySelectorAll('.exercise-row'))
                .map(r => r.querySelector('.exercise-row-name').textContent);

            // Drop visual state. Clear inline styles on every row.
            _exDrag.row.classList.remove('dragging');
            _exDrag.row.style.transform = '';
            _exDrag.otherRows.forEach(r => {
                r.style.transition = '';
                r.style.transform = '';
            });
            _exDrag = null;

            persistExerciseOrder(finalOrder);
        } else if (e.pointerType !== 'touch' && dist < 5 && elapsed < 500) {
            openSetsScreen(exerciseName);
        } else if (e.pointerType === 'touch' && dist < 8 && elapsed < 350) {
            openSetsScreen(exerciseName);
        }

        activePointerId = null;
        dragArmed = false;
    };

    row.addEventListener('pointerdown', onPointerDown);
}

function persistExerciseOrder(newOrder) {
    const lib = getExerciseLibrary();
    lib[activeMuscle] = newOrder;
    saveExerciseLibrary(lib);

    // Mirror into master library
    const master = getMasterLibrary();
    if (master[activeMuscle]) {
        const archived = master._archived?.[activeMuscle] || [];
        const newMaster = newOrder.slice();
        master[activeMuscle].forEach(e => {
            if (!newMaster.includes(e) && !archived.includes(e)) newMaster.push(e);
        });
        master[activeMuscle] = newMaster;
        saveMasterLibrary(master);
    }

    // Re-render to refresh data attributes / event handlers cleanly
    renderExerciseList();
}

function deleteExercise(ex) {

    const lib = getExerciseLibrary();
    lib[activeMuscle] = (lib[activeMuscle] || []).filter(e => e !== ex);
    saveExerciseLibrary(lib);


    const master = getMasterLibrary();
    if (!master._archived) master._archived = {};
    if (!master._archived[activeMuscle]) master._archived[activeMuscle] = [];
    if (!master._archived[activeMuscle].includes(ex)) master._archived[activeMuscle].push(ex);
    master[activeMuscle] = (master[activeMuscle] || []).filter(e => e !== ex);
    saveMasterLibrary(master);


    const logs = getExerciseLogs();
    const logKey = getDayLogKey(activeMuscle, ex);
    delete logs[logKey];
    saveExerciseLogs(logs);


    renderExerciseList();
    refreshChartAfterDataChange();
}

document.getElementById('addExerciseBtn').onclick = () => {
    const input = document.getElementById('newExerciseInput');
    const name = input.value.trim();
    if (!name) return;


    const lib = getExerciseLibrary();
    if (!lib[activeMuscle]) lib[activeMuscle] = [];
    if (!lib[activeMuscle].map(e => e.toLowerCase()).includes(name.toLowerCase())) {
        lib[activeMuscle].push(name);
    }
    saveExerciseLibrary(lib);


    const master = getMasterLibrary();
    if (!master[activeMuscle]) master[activeMuscle] = [];

    const archived = (master._archived?.[activeMuscle] || []);
    const archivedMatch = archived.find(e => e.toLowerCase() === name.toLowerCase());
    if (archivedMatch) {
        master._archived[activeMuscle] = archived.filter(e => e !== archivedMatch);
        if (!master[activeMuscle].includes(archivedMatch)) master[activeMuscle].push(archivedMatch);
    } else if (!master[activeMuscle].map(e => e.toLowerCase()).includes(name.toLowerCase())) {
        master[activeMuscle].push(name);
    }
    saveMasterLibrary(master);

    input.value = '';
    renderExerciseList();
};

document.getElementById('newExerciseInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('addExerciseBtn').click();
});

function openSetsScreen(exercise) {
    activeExercise = exercise;
    const titleEl = document.getElementById('ex-exercise-title');
    titleEl.textContent = exercise.toUpperCase();
    // Click the exercise name to open its notes screen (rename happens there)
    titleEl.classList.add('editable-title');
    titleEl.style.cursor = 'pointer';
    titleEl.onclick = () => openExerciseNotesScreen(exercise);
    renderSets();
    showExScreen('ex-screen-sets');
}

function renderSets() {
    const container = document.getElementById('sets-list');
    container.innerHTML = '';
    const logs = getExerciseLogs();
    const checks = getExerciseChecks();
    const logKey = getDayLogKey(activeMuscle, activeExercise);

    // Use today's saved sets if present, otherwise inherit yesterday's so the
    // weights/reps fields are pre-filled with the user's previous numbers.
    let saved = logs[logKey];
    if (!saved) {
        const inherited = getInheritedLog(activeMuscle, activeExercise);
        saved = inherited
            ? inherited.map(s => ({ weight: s.weight || '', reps: s.reps || '' }))
            : [{weight:'',reps:''},{weight:'',reps:''},{weight:'',reps:''}];
    }
    // Per-day checked state — never inherited; each new day starts unchecked.
    const todaysChecks = checks[logKey] || [false, false, false];


    const header = document.createElement('div');
    header.className = 'set-row';
    header.innerHTML = `
        <span class="set-label"></span>
        <div class="set-input-group">
            <span class="set-col-label">WEIGHT</span>
            <span class="set-divider" style="visibility:hidden">×</span>
            <span class="set-col-label">REPS</span>
        </div>
    `;
    container.appendChild(header);

    for (let i = 0; i < 3; i++) {
        const row = document.createElement('div');
        row.className = 'set-row';

        const label = document.createElement('span');
        label.className = 'set-label';
        if (todaysChecks[i]) label.classList.add('checked');
        label.textContent = `SET ${i + 1}`;
        // Click to toggle checked state — this is what counts as "worked out today"
        label.onclick = () => {
            const allChecks = getExerciseChecks();
            const current = allChecks[logKey] || [false, false, false];
            current[i] = !current[i];
            allChecks[logKey] = current;
            saveExerciseChecks(allChecks);
            label.classList.toggle('checked', current[i]);
            refreshChartAfterDataChange();
        };

        const group = document.createElement('div');
        group.className = 'set-input-group';

        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.className = 'set-input';
        weightInput.placeholder = 'kg';
        weightInput.value = saved[i]?.weight || '';
        weightInput.id = `set-weight-${i}`;

        const divider = document.createElement('span');
        divider.className = 'set-divider';
        divider.textContent = '×';

        const repsInput = document.createElement('input');
        repsInput.type = 'number';
        repsInput.className = 'set-input';
        repsInput.placeholder = 'reps';
        repsInput.value = saved[i]?.reps || '';
        repsInput.id = `set-reps-${i}`;

        function makeStepper(input, delta) {
            const btn = document.createElement('button');
            btn.className = 'set-stepper';
            btn.textContent = delta > 0 ? '+' : '−';
            btn.onclick = () => {
                const current = parseFloat(input.value) || 0;
                input.value = Math.max(0, current + delta);
            };
            return btn;
        }

        group.appendChild(makeStepper(weightInput, -1));
        group.appendChild(weightInput);
        group.appendChild(makeStepper(weightInput, 1));
        group.appendChild(divider);
        group.appendChild(makeStepper(repsInput, -1));
        group.appendChild(repsInput);
        group.appendChild(makeStepper(repsInput, 1));
        row.appendChild(label);
        row.appendChild(group);
        container.appendChild(row);
    }
}

document.getElementById('saveSetsBtn').onclick = () => {
    const logs = getExerciseLogs();
    const logKey = getDayLogKey(activeMuscle, activeExercise);
    const sets = [];
    for (let i = 0; i < 3; i++) {
        sets.push({
            weight: document.getElementById(`set-weight-${i}`).value,
            reps: document.getElementById(`set-reps-${i}`).value,
        });
    }
    logs[logKey] = sets;
    saveExerciseLogs(logs);
    refreshChartAfterDataChange();
    renderExerciseList();
    showExScreen('ex-screen-exercises');
};

// ─── Exercise notes screen ──────────────────────────────────────────
function openExerciseNotesScreen(exercise) {
    activeExercise = exercise;
    const titleEl = document.getElementById('ex-notes-title');
    titleEl.textContent = exercise.toUpperCase();

    // Click the title to rename the exercise
    makeTitleEditable(
        titleEl,
        () => activeExercise,
        (newName) => {
            renameExercise(activeMuscle, activeExercise, newName);
            activeExercise = newName;
        }
    );

    const notes = getExerciseNotes();
    document.getElementById('exNotesInput').value =
        notes[getExerciseNoteKey(activeMuscle, exercise)] || '';
    showExScreen('ex-screen-ex-notes');
    setTimeout(() => document.getElementById('exNotesInput').focus(), 50);
}

// Rename an exercise everywhere it appears: every day's library snapshot,
// the master library, every day's set log, all checks, and any notes.
function renameExercise(muscle, oldName, newName) {
    if (oldName === newName) return;

    // 1) Every per-day library snapshot
    const allKeys = Object.keys(_cache);
    allKeys.forEach(k => {
        if (k.startsWith('exercise_library__')) {
            try {
                const lib = JSON.parse(_cache[k]);
                if (lib[muscle]) {
                    const idx = lib[muscle].indexOf(oldName);
                    if (idx >= 0) {
                        lib[muscle][idx] = newName;
                        Storage.setItem(k, JSON.stringify(lib));
                    }
                }
            } catch(e) {}
        }
    });

    // 2) Master library
    const master = getMasterLibrary();
    if (master[muscle]) {
        const idx = master[muscle].indexOf(oldName);
        if (idx >= 0) master[muscle][idx] = newName;
        saveMasterLibrary(master);
    }

    // 3) Migrate set logs (every dated key with this muscle+exercise)
    const logs = getExerciseLogs();
    const oldSuffix = `__${muscle}__${oldName}`;
    const newSuffix = `__${muscle}__${newName}`;
    Object.keys(logs).forEach(k => {
        if (k.endsWith(oldSuffix)) {
            const datePart = k.slice(0, k.length - oldSuffix.length);
            logs[datePart + newSuffix] = logs[k];
            delete logs[k];
        }
    });
    saveExerciseLogs(logs);

    // 4) Migrate checked-set state similarly
    const checks = getExerciseChecks();
    Object.keys(checks).forEach(k => {
        if (k.endsWith(oldSuffix)) {
            const datePart = k.slice(0, k.length - oldSuffix.length);
            checks[datePart + newSuffix] = checks[k];
            delete checks[k];
        }
    });
    saveExerciseChecks(checks);

    // 5) Migrate the per-exercise note
    const notes = getExerciseNotes();
    const oldNoteKey = getExerciseNoteKey(muscle, oldName);
    const newNoteKey = getExerciseNoteKey(muscle, newName);
    if (notes[oldNoteKey]) {
        notes[newNoteKey] = notes[oldNoteKey];
        delete notes[oldNoteKey];
        saveExerciseNotes(notes);
    }
}

document.getElementById('exNotesSaveBtn').onclick = () => {
    const notes = getExerciseNotes();
    notes[getExerciseNoteKey(activeMuscle, activeExercise)] =
        document.getElementById('exNotesInput').value.trim();
    saveExerciseNotes(notes);
    // Go back to sets screen so the user is in workout flow
    openSetsScreen(activeExercise);
};

document.getElementById('exBackToSets').onclick = () => {
    openSetsScreen(activeExercise);
};

document.getElementById('closeExerciseModal5').onclick = () => {
    document.getElementById('exerciseModal').style.display = 'none';
};


document.getElementById('exBackToMuscles').onclick = () => {
    renderMuscleGrid();
    showExScreen('ex-screen-muscles');
};
document.getElementById('exBackToExercises').onclick = () => {
    renderExerciseList();
    showExScreen('ex-screen-exercises');
};


['closeExerciseModal','closeExerciseModal2','closeExerciseModal3'].forEach(id => {
    document.getElementById(id).onclick = () => {
        document.getElementById('exerciseModal').style.display = 'none';
    };
});


window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ['exerciseModal','spiritualModal','mindfulnessModal','recoveryModal','reflectionModal','mindsetModal']
            .forEach(id => document.getElementById(id).style.display = 'none');
    }
});


let activeEntryId = null;

function getSpiritualEntries() {
    const raw = Storage.getItem(SPIRITUAL_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] || [];
}

function saveSpiritualEntries(entries) {
    const raw = Storage.getItem(SPIRITUAL_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = entries;
    Storage.setItem(SPIRITUAL_KEY, JSON.stringify(all));
}

function openSpiritualModal() {
    renderSpiritualList();
    showSpScreen('sp-screen-list');
    document.getElementById('spiritualModal').style.display = 'flex';
}

function showSpScreen(id) {
    ['sp-screen-list', 'sp-screen-editor'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

function renderSpiritualList() {
    const list = document.getElementById('sp-entry-list');
    list.innerHTML = '';
    const entries = getSpiritualEntries();

    if (entries.length === 0) {
        list.innerHTML = '<p class="empty-state">No entries yet. Add one below.</p>';
        return;
    }

    entries.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'sp-entry-row';

        const topic = document.createElement('span');
        topic.className = 'sp-entry-topic';
        topic.textContent = entry.topic || 'Untitled';

        const del = document.createElement('button');
        del.className = 'exercise-delete-btn';
        del.textContent = '×';
        del.title = 'Delete entry';
        del.onclick = (e) => {
            e.stopPropagation();
            const entries = getSpiritualEntries();
            entries.splice(idx, 1);
            saveSpiritualEntries(entries);
            renderSpiritualList();

            refreshChartAfterDataChange();
        };

        row.appendChild(topic);
        row.appendChild(del);
        row.onclick = () => openEntryEditor(idx);
        list.appendChild(row);
    });
}

function openEntryEditor(idx) {
    const entries = getSpiritualEntries();
    activeEntryId = idx;
    const entry = idx === 'new' ? { topic: '', notes: '' } : entries[idx];
    document.getElementById('spTopicInput').value = entry.topic || '';
    document.getElementById('spNotesInput').value = entry.notes || '';
    showSpScreen('sp-screen-editor');
    setTimeout(() => document.getElementById('spTopicInput').focus(), 50);
}

document.getElementById('spAddEntryBtn').onclick = () => openEntryEditor('new');

document.getElementById('spSaveEntryBtn').onclick = () => {
    const topic = document.getElementById('spTopicInput').value.trim();
    const notes = document.getElementById('spNotesInput').value.trim();
    const entries = getSpiritualEntries();

    if (activeEntryId === 'new') {
        entries.push({ topic, notes });
    } else {
        entries[activeEntryId] = { topic, notes };
    }

    saveSpiritualEntries(entries);
    refreshChartAfterDataChange();
    renderSpiritualList();
    showSpScreen('sp-screen-list');
};

document.getElementById('spBackToList').onclick = () => {
    renderSpiritualList();
    showSpScreen('sp-screen-list');
};

['closeSpiritualModal', 'closeSpiritualModal2'].forEach(id => {
    document.getElementById(id).onclick = () => {
        document.getElementById('spiritualModal').style.display = 'none';
    };
});

const JOURNAL_CONFIGS = {
    mindfulness: { key: 'journal_entries__mindfulness', modalId: 'mindfulnessModal', prefix: 'mf' },
    recovery:    { key: 'journal_entries__recovery',    modalId: 'recoveryModal',     prefix: 'rc' },
    reflection:  { key: 'journal_entries__reflection',  modalId: 'reflectionModal',   prefix: 'rf' },
};
let activeJournalType = null;
let activeJournalEntryId = null;

function getJournalEntries(type) {
    const raw = Storage.getItem(JOURNAL_CONFIGS[type].key);
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] || [];
}
function saveJournalEntries(type, entries) {
    const raw = Storage.getItem(JOURNAL_CONFIGS[type].key);
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = entries;
    Storage.setItem(JOURNAL_CONFIGS[type].key, JSON.stringify(all));
}

function openJournalModal(type) {
    activeJournalType = type;
    renderJournalList(type);
    const cfg = JOURNAL_CONFIGS[type];
    showJournalScreen(cfg.prefix + '-screen-list');
    document.getElementById(cfg.modalId).style.display = 'flex';
}

function showJournalScreen(id) {
    const cfg = JOURNAL_CONFIGS[activeJournalType];
    const p = cfg.prefix;
    [p + '-screen-list', p + '-screen-editor'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

function renderJournalList(type) {
    const cfg = JOURNAL_CONFIGS[type];
    const list = document.getElementById(cfg.prefix + '-entry-list');
    list.innerHTML = '';
    const entries = getJournalEntries(type);

    if (entries.length === 0) {
        list.innerHTML = '<p class="empty-state">No entries yet.</p>';
        return;
    }
    entries.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'sp-entry-row';

        const topic = document.createElement('span');
        topic.className = 'sp-entry-topic';
        topic.textContent = entry.topic || 'Untitled';

        const del = document.createElement('button');
        del.className = 'exercise-delete-btn';
        del.textContent = '×';
        del.onclick = (e) => {
            e.stopPropagation();
            const entries = getJournalEntries(type);
            entries.splice(idx, 1);
            saveJournalEntries(type, entries);
            renderJournalList(type);
            refreshChartAfterDataChange();
        };
        row.appendChild(topic);
        row.appendChild(del);
        row.onclick = () => openJournalEditor(type, idx);
        list.appendChild(row);
    });
}

function openJournalEditor(type, idx) {
    const entries = getJournalEntries(type);
    activeJournalEntryId = idx;
    const entry = idx === 'new' ? { topic: '', notes: '' } : entries[idx];
    const p = JOURNAL_CONFIGS[type].prefix;
    document.getElementById(p + 'TopicInput').value = entry.topic || '';
    document.getElementById(p + 'NotesInput').value = entry.notes || '';
    showJournalScreen(p + '-screen-editor');
    setTimeout(() => document.getElementById(p + 'TopicInput').focus(), 50);
}


Object.entries(JOURNAL_CONFIGS).forEach(([type, cfg]) => {
    const p = cfg.prefix;
    document.getElementById(p + 'AddEntryBtn').onclick = () => openJournalEditor(type, 'new');

    document.getElementById(p + 'SaveEntryBtn').onclick = () => {
        const topic = document.getElementById(p + 'TopicInput').value.trim();
        const notes = document.getElementById(p + 'NotesInput').value.trim();
        const entries = getJournalEntries(type);
        if (activeJournalEntryId === 'new') {
            entries.push({ topic, notes });
        } else {
            entries[activeJournalEntryId] = { topic, notes };
        }
        saveJournalEntries(type, entries);
        refreshChartAfterDataChange();
        renderJournalList(type);
        showJournalScreen(p + '-screen-list');
    };

    document.getElementById(p + 'BackToList').onclick = () => {
        renderJournalList(type);
        showJournalScreen(p + '-screen-list');
    };

    [cfg.modalId.replace('Modal', 'Modal'), p.charAt(0).toUpperCase() + p.slice(1)].forEach(() => {});
    const closeIds = ['close' + cfg.modalId.charAt(0).toUpperCase() + cfg.modalId.slice(1),
                      'close' + cfg.modalId.charAt(0).toUpperCase() + cfg.modalId.slice(1) + '2'];

    const base = type.charAt(0).toUpperCase() + type.slice(1);
    ['close' + base + 'Modal', 'close' + base + 'Modal2'].forEach(id => {
        document.getElementById(id).onclick = () => {
            document.getElementById(cfg.modalId).style.display = 'none';
        };
    });
});


const MINDSET_NOTES_KEY = 'mindset_notes';
const MINDSET_TYPE_LABELS = { book: 'BOOKS', video: 'VIDEOS', podcast: 'PODCASTS', conversation: 'CONVERSATIONS' };
const MINDSET_TYPE_PLACEHOLDERS = { book: 'Add book...', video: 'Add video...', podcast: 'Add podcast...', conversation: 'Add conversation...' };
let activeMindsetType = null;
let activeBook = null;

function getMindsetLibraryForType(type) {
    const raw = Storage.getItem('mindset_library__' + type);
    return raw ? JSON.parse(raw) : [];
}
function saveMindsetLibraryForType(type, lib) {
    Storage.setItem('mindset_library__' + type, JSON.stringify(lib));
}
function getMindsetNotes() {
    const raw = Storage.getItem(MINDSET_NOTES_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveMindsetNotes(notes) {
    Storage.setItem(MINDSET_NOTES_KEY, JSON.stringify(notes));
}
function getMindsetNoteKey(type, item) {
    return getDateKey(viewDate) + '__' + type + '__' + item;
}

function openMindsetModal() {
    showMsScreen('ms-screen-type');
    document.getElementById('mindsetModal').style.display = 'flex';
}
function showMsScreen(id) {
    ['ms-screen-type', 'ms-screen-books', 'ms-screen-notes'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}
function openMindsetType(type) {
    activeMindsetType = type;
    document.getElementById('ms-type-title').textContent = MINDSET_TYPE_LABELS[type];
    document.getElementById('newBookInput').placeholder = MINDSET_TYPE_PLACEHOLDERS[type];
    renderBookList();
    showMsScreen('ms-screen-books');
}

function renderBookList() {
    const list = document.getElementById('ms-book-list');
    list.innerHTML = '';
    const items = getMindsetLibraryForType(activeMindsetType);
    const notes = getMindsetNotes();

    if (items.length === 0) {
        list.innerHTML = '<p class="empty-state">Nothing yet. Add one below.</p>';
        return;
    }
    items.forEach(item => {
        const noteKey = getMindsetNoteKey(activeMindsetType, item);
        const row = document.createElement('div');
        row.className = 'sp-entry-row';

        const title = document.createElement('span');
        title.className = 'sp-entry-topic';
        title.textContent = item;

        const del = document.createElement('button');
        del.className = 'exercise-delete-btn';
        del.textContent = '×';
        del.onclick = (e) => {
            e.stopPropagation();
            const lib = getMindsetLibraryForType(activeMindsetType).filter(b => b !== item);
            saveMindsetLibraryForType(activeMindsetType, lib);
            renderBookList();
            refreshChartAfterDataChange();
        };

        row.appendChild(title);
        row.appendChild(del);
        row.onclick = () => openBookNotes(item);
        list.appendChild(row);
    });
}

function openBookNotes(item) {
    activeBook = item;
    const titleEl = document.getElementById('ms-book-title');
    titleEl.textContent = item.toUpperCase();
    const notes = getMindsetNotes();
    document.getElementById('msBookNotes').value = notes[getMindsetNoteKey(activeMindsetType, item)] || '';

    // Click-to-rename the book/video/podcast/etc title
    makeTitleEditable(
        titleEl,
        () => activeBook,
        (newName) => {
            renameMindsetItem(activeMindsetType, activeBook, newName);
            activeBook = newName;
        }
    );

    showMsScreen('ms-screen-notes');
    setTimeout(() => document.getElementById('msBookNotes').focus(), 50);
}

// Rename a mindset library item (book/video/podcast/conversation) and migrate
// any existing notes to the new key, in the active type's library.
function renameMindsetItem(type, oldName, newName) {
    if (oldName === newName) return;
    // 1) library
    const lib = getMindsetLibraryForType(type);
    const idx = lib.indexOf(oldName);
    if (idx >= 0) {
        lib[idx] = newName;
        saveMindsetLibraryForType(type, lib);
    }
    // 2) notes (migrate every date that had a note for this item)
    const notes = getMindsetNotes();
    const oldSuffix = '__' + type + '__' + oldName;
    const newSuffix = '__' + type + '__' + newName;
    Object.keys(notes).forEach(k => {
        if (k.endsWith(oldSuffix)) {
            const datePart = k.slice(0, k.length - oldSuffix.length);
            notes[datePart + newSuffix] = notes[k];
            delete notes[k];
        }
    });
    saveMindsetNotes(notes);
}

document.getElementById('addBookBtn').onclick = () => {
    const input = document.getElementById('newBookInput');
    const name = input.value.trim();
    if (!name) return;
    const lib = getMindsetLibraryForType(activeMindsetType);
    if (!lib.map(b => b.toLowerCase()).includes(name.toLowerCase())) {
        lib.push(name);
        saveMindsetLibraryForType(activeMindsetType, lib);
    }
    input.value = '';
    renderBookList();
};
document.getElementById('newBookInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('addBookBtn').click();
});

document.getElementById('msSaveNotesBtn').onclick = () => {
    const notes = getMindsetNotes();
    notes[getMindsetNoteKey(activeMindsetType, activeBook)] = document.getElementById('msBookNotes').value.trim();
    saveMindsetNotes(notes);
    refreshChartAfterDataChange();
    renderBookList();
    showMsScreen('ms-screen-books');
};

document.getElementById('msBackToBooks').onclick = () => {
    renderBookList();
    showMsScreen('ms-screen-books');
};
document.getElementById('msBackToType').onclick = () => showMsScreen('ms-screen-type');

['closeMindsetModal', 'closeMindsetModal2', 'closeMindsetModal3'].forEach(id => {
    document.getElementById(id).onclick = () => {
        document.getElementById('mindsetModal').style.display = 'none';
    };
});

let activeAvoidedActivity = null;

// Returns the entries-storage key for whichever mixer mode is currently active.
// Sins write to 'avoided_entries', virtues to 'virtue_entries'.
function getActiveEntriesKey() {
    return getMixerConfig(getMixerMode()).entriesKey;
}

function getAvoidedEntries() {
    try { return JSON.parse(Storage.getItem(getActiveEntriesKey())) || {}; }
    catch(e) { return {}; }
}

function getAvoidedEntry(activity) {
    const key = getDateKey(viewDate) + '__' + activity;
    return getAvoidedEntries()[key] || null;
}

function openAvoidedModal(activity) {
    activeAvoidedActivity = activity;
    document.getElementById('avoidedModalTitle').textContent = activity.toUpperCase();
    const entry = getAvoidedEntry(activity);
    // Backward-compat: old entries had { happened, learned }; new ones have { notes }.
    // If an old entry exists, merge the two fields into the single notes field
    // so nothing is lost.
    let notesText = '';
    if (entry) {
        if (entry.notes !== undefined) {
            notesText = entry.notes;
        } else {
            const parts = [];
            if (entry.happened) parts.push(entry.happened);
            if (entry.learned) parts.push(entry.learned);
            notesText = parts.join('\n\n');
        }
    }
    document.getElementById('avoidedNotes').value = notesText;
    document.getElementById('avoidedModal').style.display = 'flex';
    setTimeout(() => document.getElementById('avoidedNotes').focus(), 50);
}

function closeAvoidedModal() {
    document.getElementById('avoidedModal').style.display = 'none';
    activeAvoidedActivity = null;
}

document.getElementById('avoidedSaveBtn').addEventListener('click', function() {
    const notes = document.getElementById('avoidedNotes').value.trim();
    const key = getDateKey(viewDate) + '__' + activeAvoidedActivity;
    const entriesKey = getActiveEntriesKey();
    let all = {};
    try { all = JSON.parse(Storage.getItem(entriesKey)) || {}; } catch(e) {}

    if (notes) {
        all[key] = { notes };
    } else {
        delete all[key];
    }

    Storage.setItem(entriesKey, JSON.stringify(all));
    renderSinsMixer();
    closeAvoidedModal();
});

document.getElementById('closeAvoidedModal').addEventListener('click', closeAvoidedModal);


window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const av = document.getElementById('avoidedModal');
        if (av && av.style.display === 'flex') { av.style.display = 'none'; activeAvoidedActivity = null; }
        const gr = document.getElementById('gratitudeModal');
        if (gr && gr.style.display === 'flex') gr.style.display = 'none';
    }
});


const GRATITUDE_KEY = 'gratitude_entries';

function getGratitudeEntries() {
    try { return JSON.parse(Storage.getItem(GRATITUDE_KEY)) || {}; }
    catch(e) { return {}; }
}

function openGratitudeModal() {
    const entries = getGratitudeEntries();
    const saved = entries[getDateKey(viewDate)] || [];
    for (let i = 1; i <= 5; i++) {
        document.getElementById('grateful' + i).value = saved[i-1] || '';
    }
    document.getElementById('gratitudeModal').style.display = 'flex';
    setTimeout(() => document.getElementById('grateful1').focus(), 50);
}

document.getElementById('gratitudeSaveBtn').addEventListener('click', function() {
    const entries = getGratitudeEntries();
    entries[getDateKey(viewDate)] = [1,2,3,4,5].map(i =>
        document.getElementById('grateful' + i).value.trim()
    );
    Storage.setItem(GRATITUDE_KEY, JSON.stringify(entries));
    document.getElementById('gratitudeModal').style.display = 'none';
});

document.getElementById('closeGratitudeModal').addEventListener('click', function() {
    document.getElementById('gratitudeModal').style.display = 'none';
});



const dayNameEl = document.getElementById('day-name');
dayNameEl.style.cursor = 'pointer';
dayNameEl.addEventListener('click', function() {
    dayNameEl.classList.add('flash');
    dayNameEl.addEventListener('animationend', function handler() {
        dayNameEl.classList.remove('flash');
        dayNameEl.removeEventListener('animationend', handler);
    });
    openGratitudeModal();
});