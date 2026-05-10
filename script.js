// ─── Supabase Storage Layer ───────────────────────────────────────────────────
// All app data lives in one row of a kv_store table per authenticated user.
// The row's `data` column is a JSON blob holding the same flat key→value map
// that JSONBin used to store, so the rest of the app code (Storage.getItem
// / setItem / removeItem) stays unchanged.
//
// Setup (do once in the Supabase dashboard — see the guide in chat):
//   1) Create a project, copy URL + anon key, paste into the constants below.
//   2) Run the SQL from the guide to create the kv_store table + RLS policies.
//   3) Enable Email auth (or Google/Magic Link) in Authentication → Providers.

const SUPABASE_URL  = 'https://xuebnjgsftnqpvjntthd.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1ZWJuamdzZnRucXB2am50dGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNzU4NzQsImV4cCI6MjA5Mzk1MTg3NH0.Xfn1g0fJvhBIit8XY3Fy3yDcIyPQiIp8D_QnNaSoALQ';

let _cache  = {};       // in-memory mirror of the user's data row
let _saveTimer = null;  // debounce handle
let _loaded = false;    // becomes true ONLY after a successful load
let _dirty  = false;    // tracks whether we have unsaved changes
let _sb     = null;     // Supabase client, set after the SDK loads
let _userId = null;     // current authenticated user's id

const Storage = {
    getItem(key) {
        return Object.prototype.hasOwnProperty.call(_cache, key) ? _cache[key] : null;
    },
    setItem(key, value) {
        _cache[key] = value;
        _dirty = true;
        _scheduleSave();
    },
    removeItem(key) {
        delete _cache[key];
        _dirty = true;
        _scheduleSave();
    }
};

function _scheduleSave() {
    if (!_loaded) return;          // never save before initial load completes
    if (_saveTimer) return;        // already scheduled
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        _flushToCloud();
    }, 10000);                     // 10s debounce, same as before
}

function _saveNow() {
    if (!_loaded || !_dirty) return;
    clearTimeout(_saveTimer);
    _saveTimer = null;
    _flushToCloud(true);
}
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _saveNow();
});
window.addEventListener('pagehide', _saveNow);
window.addEventListener('beforeunload', _saveNow);

async function _flushToCloud(immediate) {
    if (!_loaded || !_sb || !_userId) return;
    try {
        // upsert: insert if missing, update if present. Single row per user.
        const { error } = await _sb
            .from('kv_store')
            .upsert(
                { user_id: _userId, data: _cache, updated_at: new Date().toISOString() },
                { onConflict: 'user_id' }
            );
        if (error) {
            console.warn('Supabase save failed:', error.message);
            return;
        }
        _dirty = false;
    } catch (e) {
        console.warn('Supabase save threw:', e);
    }
}

async function _loadFromCloud() {
    if (!_sb || !_userId) return;
    try {
        const { data, error } = await _sb
            .from('kv_store')
            .select('data')
            .eq('user_id', _userId)
            .maybeSingle();
        if (error) {
            console.warn('Supabase load failed:', error.message);
            return;
        }
        _cache  = (data && data.data) ? data.data : {};
        _loaded = true;
    } catch (e) {
        console.warn('Supabase load threw, refusing to save until reload succeeds:', e);
        // Deliberately do NOT set _loaded = true.
    }
}

// ─── Sign-in overlay ──────────────────────────────────────────────────────────
// ─── Sign-in overlay ──────────────────────────────────────────────────────────
// Password-only flow. Behind the scenes Supabase still requires an email, so
// we use a fixed fake one and the user only ever types the password.
//
// The fake email is visible in this file (it's just a username), so the
// password is the only thing protecting the account. Pick a real password.
//
// First open: enters password → tries to sign in → if that fails, signs up
//             with the same password (creating the account).
// Every open after that: enters password → signs in.
const AUTH_FAKE_EMAIL = 'vault@vitals.local';

function _renderSignInOverlay() {
    if (document.getElementById('auth-overlay')) return;
    const wrap = document.createElement('div');
    wrap.id = 'auth-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0a0a0a;display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:inherit;color:#f0ece4;';
    wrap.innerHTML = `
      <div style="max-width:340px;width:100%;text-align:center;">
        <h2 style="font-family:inherit;letter-spacing:0.1em;font-weight:400;margin-bottom:0.4rem;">UNLOCK</h2>
        <p style="opacity:0.55;font-size:0.85rem;margin:0 0 1.4rem;">Enter your password.</p>
        <input id="auth-password" type="password" placeholder="password" autocomplete="current-password"
               style="width:100%;padding:0.7rem 0.8rem;background:#141414;border:1px solid #333;border-radius:6px;color:#f0ece4;font-size:0.95rem;margin-bottom:0.8rem;box-sizing:border-box;" />
        <button id="auth-go"
                style="width:100%;padding:0.7rem;background:#c9a96e;color:#0a0a0a;border:none;border-radius:6px;font-weight:600;letter-spacing:0.05em;cursor:pointer;">UNLOCK</button>
        <p id="auth-status" style="margin-top:1rem;font-size:0.8rem;opacity:0.7;min-height:1.2em;"></p>
      </div>`;
    document.body.appendChild(wrap);
    const status = wrap.querySelector('#auth-status');
    const pwInput = wrap.querySelector('#auth-password');
    const goBtn = wrap.querySelector('#auth-go');

    const submit = async () => {
        const password = pwInput.value;
        if (!password || password.length < 6) {
            status.textContent = 'Password must be at least 6 characters.';
            return;
        }
        status.textContent = 'Unlocking…';
        goBtn.disabled = true;

        // Try sign-in first. If the user doesn't exist yet (first run on this
        // Supabase project), fall back to sign-up with the same password.
        let { error } = await _sb.auth.signInWithPassword({
            email: AUTH_FAKE_EMAIL,
            password
        });

        if (error && /invalid login credentials/i.test(error.message)) {
            // Try creating the account on the fly.
            const { error: signUpErr } = await _sb.auth.signUp({
                email: AUTH_FAKE_EMAIL,
                password
            });
            if (signUpErr) {
                // Could be: account exists with a DIFFERENT password (wrong
                // password), or email confirmation is still on, or rate-limit.
                status.textContent = 'Wrong password.';
                goBtn.disabled = false;
                return;
            }
            // Account created. Now sign in.
            const { error: secondErr } = await _sb.auth.signInWithPassword({
                email: AUTH_FAKE_EMAIL,
                password
            });
            if (secondErr) {
                status.textContent = secondErr.message.includes('confirm')
                    ? 'Turn off "Confirm email" in Supabase Auth settings.'
                    : ('Error: ' + secondErr.message);
                goBtn.disabled = false;
                return;
            }
        } else if (error) {
            status.textContent = 'Error: ' + error.message;
            goBtn.disabled = false;
            return;
        }

        // onAuthStateChange in the boot flow will pick up the new session.
        status.textContent = 'Loading…';
    };

    goBtn.onclick = submit;
    pwInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    setTimeout(() => pwInput.focus(), 50);
}
function _removeSignInOverlay() {
    const el = document.getElementById('auth-overlay');
    if (el) el.remove();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Loads the Supabase SDK from CDN, then either signs you in (existing
// session) or shows the sign-in overlay. Once authenticated, it loads your
// row and resolves so the rest of the app can render with real data.
async function _bootCloud() {
    // Lazy-load the Supabase SDK so the app's HTML can load instantly.
    if (!window.supabase) {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
            s.onload = resolve;
            s.onerror = () => reject(new Error('Failed to load Supabase SDK'));
            document.head.appendChild(s);
        });
    }
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    // Wait for either an existing session or a fresh sign-in.
    const session = await new Promise((resolve) => {
        _sb.auth.getSession().then(({ data }) => {
            if (data.session) return resolve(data.session);
            _renderSignInOverlay();
            const { data: sub } = _sb.auth.onAuthStateChange((_event, s) => {
                if (s) { sub.subscription.unsubscribe(); resolve(s); }
            });
        });
    });

    _userId = session.user.id;
    _removeSignInOverlay();
    await _loadFromCloud();

    // Realtime: if the same account edits on another device, pull in changes.
    _sb.channel('kv_' + _userId)
       .on('postgres_changes',
           { event: '*', schema: 'public', table: 'kv_store', filter: 'user_id=eq.' + _userId },
           (payload) => {
               // Only adopt remote changes when we have nothing pending locally,
               // so we don't clobber a local edit the user just made.
               if (_dirty) return;
               if (payload.new && payload.new.data) {
                   _cache = payload.new.data;
                   if (typeof loadDayData === 'function') loadDayData();
               }
           })
       .subscribe();
}

// Kept under the original name for the call site below — it's the
// "wait until cloud data is ready" promise the rest of the app relies on.
async function _loadFromJsonBin() {
    return _bootCloud();
}

// ─── Backup helpers ───────────────────────────────────────────────────────────
// Even with Supabase, a manual export gives you a file you control no matter
// what happens to the service. Open the dev console and call:
//   exportData()        -> downloads vitals-backup-YYYY-MM-DD.json
//   importData(json)    -> replaces all data with the contents of a backup
//   importFromJsonBin() -> one-time pull from the OLD JSONBin (uses the old creds)
window.exportData = function () {
    const blob = new Blob([JSON.stringify(_cache, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vitals-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
};
window.importData = function (json) {
    const obj = (typeof json === 'string') ? JSON.parse(json) : json;
    if (!obj || typeof obj !== 'object') throw new Error('Invalid backup');
    _cache = obj;
    _dirty = true;
    _flushToCloud(true);
    if (typeof loadDayData === 'function') loadDayData();
};
window.importFromJsonBin = async function () {
    const url = 'https://api.jsonbin.io/v3/b/69f53af2856a6821899747a5/latest';
    const headers = {
        'Content-Type': 'application/json',
        'X-Master-Key': '$2a$10$3y.dwt/3tzWk3GSu3tXtDeFKHKk25l68iLnGPUjauJA8zdcHfmMji'
    };
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error('JSONBin fetch failed: ' + res.status);
    const data = await res.json();
    window.importData(data.record || {});
    console.log('Imported from JSONBin. Cloud save will fire within 10s.');
};
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

// ─── GLOBAL SLIDER LEVELS ─────────────────────────────────────────────────
// Sin and virtue slider values are global (same across every day).
// Stored as a flat { activity: value } map at SIN_LEVELS_KEY / VIRTUE_LEVELS_KEY.
// The associated NOTES (entriesKey) remain per-day — only the slider numbers
// are shared.
//
// Notes on storage shape detection:
//   New (global)   : { "Pride": 5, "Greed": 3, ... }
//   Old (per-day)  : { "2026-05-08": { "Pride": 5 }, "2026-05-09": {...} }
// We can tell them apart because date keys match YYYY-MM-DD.
const _DATE_KEY_RX = /^\d{4}-\d{2}-\d{2}$/;
function _looksLikePerDay(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    if (keys.length === 0) return false;
    return keys.some(k => _DATE_KEY_RX.test(k));
}

// One-time migration: collapse per-day levels down to today's values only.
// Idempotent — safe to call multiple times.
const LEVELS_MIGRATED_FLAG = 'levels_global_migrated_v1';
function migrateLevelsToGlobal() {
    if (Storage.getItem(LEVELS_MIGRATED_FLAG) === '1') return;
    [SIN_LEVELS_KEY, VIRTUE_LEVELS_KEY].forEach(key => {
        let parsed;
        try { parsed = JSON.parse(Storage.getItem(key) || 'null'); }
        catch (e) { parsed = null; }
        if (!_looksLikePerDay(parsed)) return; // already flat or empty
        const todayValues = parsed[getDateKey(new Date())] || {};
        Storage.setItem(key, JSON.stringify(todayValues));
    });
    Storage.setItem(LEVELS_MIGRATED_FLAG, '1');
}

function getAllSinLevels() {
    // Back-compat shim: returns the flat global map. Kept so any leftover
    // caller doesn't crash. New code should use getLevelsForDay(SIN_LEVELS_KEY).
    try {
        const parsed = JSON.parse(Storage.getItem(SIN_LEVELS_KEY)) || {};
        // Defensive: if pre-migration data is read, return today's slice.
        if (_looksLikePerDay(parsed)) return parsed[getDateKey(viewDate)] || {};
        return parsed;
    } catch(e) { return {}; }
}
function getSinLevelsForDay() {
    return getAllSinLevels(); // global = same every day
}
function setSinLevel(activity, value) {
    setLevel(SIN_LEVELS_KEY, activity, value);
}

// Generic versions used by the mixer renderer — work with any storage key.
// Levels are now GLOBAL: every day reads and writes the same flat map.
function getAllLevels(key) {
    try {
        const parsed = JSON.parse(Storage.getItem(key)) || {};
        // If we encounter pre-migration per-day data (e.g. cloud save raced
        // ahead of migration), fall back to today's slice rather than the
        // outer object so callers get sensible numbers.
        if (_looksLikePerDay(parsed)) return parsed[getDateKey(viewDate)] || {};
        return parsed;
    } catch(e) { return {}; }
}
function getLevelsForDay(key) {
    return getAllLevels(key); // global = same every day
}
function setLevel(key, activity, value) {
    const all = getAllLevels(key);
    if (value === 0) {
        delete all[activity];
    } else {
        all[activity] = value;
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
    if (catName === 'Recovery') {
        const raw = Storage.getItem('recovery_data');
        if (!raw) return false;
        const all = JSON.parse(raw);
        const day = all[getDateKey(viewDate)] || {};
        return !!(day.hydration || day.cryotherapy || day.nutrition != null || day.sleep != null);
    }
    if (catName === 'Mindfulness') {
        return getMfMinutes() > 0;
    }
    if (catName === 'Reflection') {
        const raw = Storage.getItem('reflection_321');
        if (!raw) return false;
        const day = (JSON.parse(raw))[getDateKey(viewDate)] || {};
        return [...(day.happy || []), ...(day.grateful || []), ...(day.learned || []), ...(day.better || [])].some(v => v && v.trim());
    }
    if (catName === 'Mindset') {
        return ['book', 'video', 'podcast', 'conversation'].some(t => mindsetTypeHasDataToday(t));
    }
    if (catName === 'Mobility') {
        const datePrefix = getDateKey(viewDate) + '__';
        const checks = JSON.parse(Storage.getItem('exercise_set_checks') || '{}');
        if (Object.keys(checks).some(k => k.startsWith(datePrefix) && (checks[k] || []).some(Boolean))) return true;
        return mobilityOtherHasDataToday();
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
_loadFromJsonBin().then(() => {
    migrateLevelsToGlobal();
    pruneOrphanedChecks();
    loadDayData();
}); // re-render once remote data arrives


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

            const realToday = new Date();
            if (dayNumber === realToday.getDate() &&
                month === realToday.getMonth() &&
                year === realToday.getFullYear()) {
                div.classList.add('today');
            }

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


// ── Calendar drag-to-switch: 3-panel sliding track ───────────────────────────
(function () {
    const COMMIT_THRESHOLD = 60;
    const DRAG_THRESHOLD   = 8;

    const calModal   = document.getElementById('calendarModal');
    const calContent = document.querySelector('#calendarModal .modal-content');
    const origGrid   = document.getElementById('calendarGrid');
    const monthLabel = document.getElementById('monthYearLabel');

    // Wrap calendarGrid in a 3-panel flex track  [prev | current | next]
    const swipeWrap  = document.createElement('div');
    swipeWrap.style.cssText = 'overflow:hidden;width:100%;touch-action:none;';

    const swipeTrack = document.createElement('div');
    swipeTrack.style.cssText = 'display:flex;will-change:transform;gap:16px;transform:translateX(calc(-100% - 16px));';

    const panelPrev = document.createElement('div');
    panelPrev.className = 'calendar-grid';
    const panelNext = document.createElement('div');
    panelNext.className = 'calendar-grid';

    [panelPrev, origGrid, panelNext].forEach(el => {
        el.style.flex     = '0 0 100%';
        el.style.minWidth = '0';
    });

    origGrid.parentNode.insertBefore(swipeWrap, origGrid);
    origGrid.remove();
    swipeTrack.appendChild(panelPrev);
    swipeTrack.appendChild(origGrid);
    swipeTrack.appendChild(panelNext);
    swipeWrap.appendChild(swipeTrack);

    // Render any month into any container
    function renderInto(container, year, month) {
        container.innerHTML = '';
        const firstDay    = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevLastDay = new Date(year, month, 0).getDate();
        for (let i = 0; i < 42; i++) {
            const box = document.createElement('div');
            box.className = 'day-box';
            if (i < firstDay) {
                box.textContent = prevLastDay - firstDay + i + 1;
                box.classList.add('other-month');
            } else if (i >= firstDay + daysInMonth) {
                box.textContent = i - (firstDay + daysInMonth) + 1;
                box.classList.add('other-month');
            } else {
                const d = i - firstDay + 1;
                box.textContent = d;
                if (d === viewDate.getDate() && month === viewDate.getMonth() && year === viewDate.getFullYear())
                    box.classList.add('current');
                box.onclick = ((y, m, day) => () => {
                    viewDate = new Date(y, m, day);
                    loadDayData();
                    calModal.style.display = 'none';
                })(year, month, d);
            }
            container.appendChild(box);
        }
    }

    function setPos(dx) {
        swipeTrack.style.transition = 'none';
        swipeTrack.style.transform  = `translateX(calc(-100% - 16px + ${dx}px))`;
    }

    function animateTo(dx, onDone) {
        swipeTrack.style.transition = 'transform 0.3s cubic-bezier(0.25,0.46,0.45,0.94)';
        swipeTrack.style.transform  = `translateX(calc(-100% - 16px + ${dx}px))`;
        if (onDone) swipeTrack.addEventListener('transitionend', onDone, { once: true });
    }

    let startX = 0, startY = 0, tracking = false, dragging = false, currentDx = 0, capturedId = null, transitioning = false;

    calContent.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'BUTTON' || tracking) return;
        startX = e.clientX; startY = e.clientY;
        currentDx = 0; dragging = false; tracking = true; capturedId = e.pointerId;

        // Pre-fill adjacent panels immediately so they're in frame as soon as the user drags
        const prev = new Date(calendarDate); prev.setMonth(prev.getMonth() - 1);
        const next = new Date(calendarDate); next.setMonth(next.getMonth() + 1);
        renderInto(panelPrev, prev.getFullYear(), prev.getMonth());
        renderInto(panelNext, next.getFullYear(), next.getMonth());
    });

    calContent.addEventListener('pointermove', (e) => {
        if (!tracking || e.pointerId !== capturedId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!dragging) {
            if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            if (Math.abs(dy) > Math.abs(dx)) { tracking = false; return; } // vertical scroll
            dragging = true;
            try { calContent.setPointerCapture(e.pointerId); } catch (_) {}
        }

        e.preventDefault();
        currentDx = dx;
        setPos(dx);
    });

    const endDrag = (e) => {
        if (!tracking || e.pointerId !== capturedId) return;
        tracking = false; capturedId = null;
        if (!dragging) return;

        if (Math.abs(currentDx) >= COMMIT_THRESHOLD) {
            const goNext = currentDx < 0;
            const w      = swipeWrap.offsetWidth;
            animateTo(goNext ? -(w + 16) : (w + 16), () => {
                calendarDate.setMonth(calendarDate.getMonth() + (goNext ? 1 : -1));
                renderCalendar();   // refill origGrid + update month label text
                setPos(0);          // snap back to center with new content (no visible flash)
            });
        } else {
            animateTo(0);
        }
    };

    calContent.addEventListener('pointerup',     endDrag);
    calContent.addEventListener('pointercancel', endDrag);

    function animateMonth(goNext) {
        if (transitioning) return;
        transitioning = true;
        const target = new Date(calendarDate);
        target.setMonth(target.getMonth() + (goNext ? 1 : -1));
        renderInto(goNext ? panelNext : panelPrev, target.getFullYear(), target.getMonth());
        const w = swipeWrap.offsetWidth;
        animateTo(goNext ? -(w + 16) : (w + 16), () => {
            transitioning = false;
            calendarDate.setMonth(calendarDate.getMonth() + (goNext ? 1 : -1));
            renderCalendar();
            setPos(0);
        });
    }

    document.getElementById('prevMonth').onclick = () => animateMonth(false);
    document.getElementById('nextMonth').onclick = () => animateMonth(true);
})();

const noteModal = document.getElementById('noteModal');
const noteArea = document.getElementById('noteArea');
const noteTitle = document.getElementById('noteTitle');
let activeNoteIdx = null;

function openNoteModal(index) {
    const cat = categories[index];
    if (cat.name === 'Mobility') { openExerciseModal(); return; }
    if (cat.name === 'Spirituality') { openSpiritualModal(); return; }
    if (cat.name === 'Mindfulness') { openMindfulnessModal(); return; }
    if (cat.name === 'Recovery') { openRecoveryModal(); return; }
    if (cat.name === 'Reflection') { openReflectionModal(); return; }
    if (cat.name === 'Mindset') { openMindsetModal(); return; }
    activeNoteIdx = index;
    noteTitle.textContent = cat.name.toUpperCase() + " NOTES";
    noteArea.value = cat.note || "";
    noteModal.style.display = 'flex';
    setTimeout(() => noteArea.focus(), 50);
}

document.getElementById('closeNoteModal').onclick = () => {
    if (activeNoteIdx !== null) {
        categories[activeNoteIdx].note = noteArea.value;
        saveDayData();
        refreshChartAfterDataChange();
    }
    noteModal.style.display = 'none';
    activeNoteIdx = null;
};


window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        modal.style.display = 'none';
        noteModal.style.display = 'none';
    }
});

function renderSinsMixer(opts, targetContainer, targetMode) {
    const container = targetContainer || document.getElementById('sins-mixer');
    if (!container) return;

    const mode = targetMode || getMixerMode();
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
        label.textContent = (mode === 'virtues' && window.innerWidth <= 480 && activity.length > 5)
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

        // Pointer-based drag — determines direction before capturing the pointer.
        // Horizontal gestures are left to the outer swipe layer; vertical ones
        // capture here for slider-only handling.
        let dragging = false;
        let startClientY = 0;
        let startClientX = 0;
        let startValue = 0;
        let sliderDecided = false;

        const onPointerDown = (e) => {
            e.preventDefault();
            dragging = true;
            sliderDecided = false;
            startClientY = e.clientY;
            startClientX = e.clientX;
            startValue = currentValue;
        };
        const onPointerMove = (e) => {
            if (!dragging) return;

            if (window.__mixerSwipeActive) {
                if (currentValue !== startValue) {
                    currentValue = startValue;
                    setLevel(cfg.levelsKey, activity, startValue);
                    sync();
                }
                dragging = false;
                return;
            }

            if (!sliderDecided) {
                const adx = Math.abs(e.clientX - startClientX);
                const ady = Math.abs(e.clientY - startClientY);
                if (adx < 3 && ady < 3) return;
                if (adx >= ady) { dragging = false; return; } // horizontal — swipe layer handles it
                sliderDecided = true;
                try { wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId); } catch (_) {}
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
            sliderDecided = false;
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

}

// ── Mixer drag-to-switch: 3-panel sliding track ──────────────────────────────
(function () {
    const COMMIT_THRESHOLD = 50;
    const DRAG_THRESHOLD   = 8;
    const GAP              = 16;

    const origContainer = document.getElementById('sins-mixer');
    if (!origContainer) return;

    const swipeWrap = document.createElement('div');
    swipeWrap.style.cssText = 'overflow:hidden;width:100%;';

    const swipeTrack = document.createElement('div');
    swipeTrack.style.cssText = `display:flex;will-change:transform;gap:${GAP}px;transform:translateX(calc(-100% - ${GAP}px));`;

    const panelPrev = document.createElement('div');
    const panelNext = document.createElement('div');
    // Match the gap/padding of #sins-mixer at the current breakpoint so
    // adjacent-panel content doesn't overflow and clip edge slots on mobile.
    const _mixerGap  = window.innerWidth <= 480 ? 8  : 22;
    const _mixerPad  = window.innerWidth <= 480 ? '0 2px' : '0 4px';
    [panelPrev, panelNext].forEach(p => {
        p.style.cssText = `display:flex;justify-content:center;align-items:flex-end;gap:${_mixerGap}px;padding:${_mixerPad};flex:0 0 100%;min-width:0;`;
    });

    const centerPanel = document.createElement('div');
    centerPanel.style.cssText = 'flex:0 0 100%;min-width:0;display:flex;justify-content:center;align-items:flex-end;';

    origContainer.style.maxWidth = 'none';

    origContainer.parentNode.insertBefore(swipeWrap, origContainer);
    origContainer.remove();
    centerPanel.appendChild(origContainer);
    swipeTrack.appendChild(panelPrev);
    swipeTrack.appendChild(centerPanel);
    swipeTrack.appendChild(panelNext);
    swipeWrap.appendChild(swipeTrack);

    // Pre-render both adjacent panels now so there is no DOM reflow mid-swipe
    // (lazy rendering was causing a visible jump on mobile).
    function _preRenderAdjacent() {
        const other = getMixerMode() === 'sins' ? 'virtues' : 'sins';
        renderSinsMixer({}, panelPrev, other);
        renderSinsMixer({}, panelNext, other);
    }
    _preRenderAdjacent();

    function setPos(dx) {
        swipeTrack.style.transition = 'none';
        swipeTrack.style.transform  = `translateX(calc(-100% - ${GAP}px + ${dx}px))`;
    }
    function animateTo(dx, onDone) {
        swipeTrack.style.transition = 'transform 0.3s cubic-bezier(0.25,0.46,0.45,0.94)';
        swipeTrack.style.transform  = `translateX(calc(-100% - ${GAP}px + ${dx}px))`;
        if (onDone) swipeTrack.addEventListener('transitionend', onDone, { once: true });
    }

    let startX = 0, startY = 0, tracking = false, dragging = false, currentDx = 0, capturedId = null;

    swipeWrap.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'BUTTON' || tracking) return;
        startX = e.clientX; startY = e.clientY;
        currentDx = 0; dragging = false; tracking = true; capturedId = e.pointerId;
        window.__mixerSwipeActive = false;
    });

    swipeWrap.addEventListener('pointermove', (e) => {
        if (!tracking || e.pointerId !== capturedId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!dragging) {
            if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            if (Math.abs(dy) > Math.abs(dx)) { tracking = false; return; }
            dragging = true;
            window.__mixerSwipeActive = true;
            try { swipeWrap.setPointerCapture(e.pointerId); } catch (_) {}
        }

        e.preventDefault();
        currentDx = dx;
        setPos(dx);
    });

    const endDrag = (e) => {
        if (!tracking || e.pointerId !== capturedId) return;
        tracking = false; capturedId = null;
        if (!dragging) { window.__mixerSwipeActive = false; return; }

        if (Math.abs(currentDx) >= COMMIT_THRESHOLD) {
            const goNext = currentDx < 0;
            const w = swipeWrap.offsetWidth;
            animateTo(goNext ? -(w + GAP) : (w + GAP), () => {
                const newMode = getMixerMode() === 'sins' ? 'virtues' : 'sins';
                setMixerMode(newMode);
                renderSinsMixer();
                _preRenderAdjacent();
                setPos(0);
                setTimeout(() => { window.__mixerSwipeActive = false; }, 0);
            });
        } else {
            animateTo(0);
            setTimeout(() => { window.__mixerSwipeActive = false; }, 0);
        }
    };

    swipeWrap.addEventListener('pointerup',     endDrag);
    swipeWrap.addEventListener('pointercancel', endDrag);
})()

const EXERCISE_LIBRARY_KEY = 'exercise_library';
const EXERCISE_LOGS_KEY = 'exercise_logs';
const EXERCISE_CHECKS_KEY = 'exercise_set_checks';
const EXERCISE_NOTES_KEY = 'exercise_notes';

const muscleGroups = ['Triceps', 'Biceps', 'Shoulders', 'Chest', 'Back', 'Abs', 'Legs'];
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

// Remove check entries for exercises that no longer exist in the master library.
// Runs once at startup to clear orphaned data left by previous exercise deletions.
function pruneOrphanedChecks() {
    const master = getMasterLibrary();
    const checks = getExerciseChecks();
    let changed = false;
    Object.keys(checks).forEach(k => {
        const parts = k.split('__');
        if (parts.length < 3) { delete checks[k]; changed = true; return; }
        const muscle = parts[1];
        const exercise = parts.slice(2).join('__');
        const validExercises = Array.isArray(master[muscle]) ? master[muscle] : [];
        if (!validExercises.includes(exercise)) { delete checks[k]; changed = true; }
    });
    if (changed) saveExerciseChecks(checks);
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
    ['ex-screen-muscles','ex-screen-exercises','ex-screen-sets','ex-screen-simple','ex-screen-ex-notes','ex-screen-mobility-other'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

const MOBILITY_EXTRAS = [];   // no more simple-toggle extras
const MOBILITY_SIMPLE_KEY = 'mobility_simple_notes';

// ─── Mobility "Other" list ────────────────────────────────────────────────────
// String literals used directly (not consts) so these functions are safe to
// call from isCategoryCompleted() before the rest of this section executes.
function getMobilityOtherLibrary() {
    const raw = Storage.getItem('mobility_other_library');
    return raw ? JSON.parse(raw) : [];
}
function saveMobilityOtherLibrary(lib) {
    Storage.setItem('mobility_other_library', JSON.stringify(lib));
}
function getMobilityOtherChecks() {
    const raw = Storage.getItem('mobility_other_checks');
    return raw ? JSON.parse(raw) : {};
}
function saveMobilityOtherChecks(checks) {
    Storage.setItem('mobility_other_checks', JSON.stringify(checks));
}
function getMobilityOtherNotes() {
    const raw = Storage.getItem('mobility_other_notes');
    return raw ? JSON.parse(raw) : {};
}
function saveMobilityOtherNotes(notes) {
    Storage.setItem('mobility_other_notes', JSON.stringify(notes));
}
function getMobilityOtherNoteKey(item) {
    return getDateKey(viewDate) + '__' + item;
}
function isMobilityOtherChecked(item) {
    return !!getMobilityOtherChecks()[getMobilityOtherNoteKey(item)];
}
function setMobilityOtherChecked(item, val) {
    const checks = getMobilityOtherChecks();
    const key = getMobilityOtherNoteKey(item);
    if (val) checks[key] = true; else delete checks[key];
    saveMobilityOtherChecks(checks);
}
function mobilityOtherHasDataToday() {
    const prefix = getDateKey(viewDate) + '__';
    const notes  = getMobilityOtherNotes();
    if (Object.keys(notes).some(k => k.startsWith(prefix) && notes[k])) return true;
    const checks = getMobilityOtherChecks();
    return Object.keys(checks).some(k => k.startsWith(prefix) && checks[k]);
}
function renameMobilityOtherItem(oldName, newName) {
    if (oldName === newName) return;
    const lib = getMobilityOtherLibrary();
    const idx = lib.indexOf(oldName);
    if (idx >= 0) { lib[idx] = newName; saveMobilityOtherLibrary(lib); }
    const oldSuffix = '__' + oldName;
    const newSuffix = '__' + newName;
    const notes = getMobilityOtherNotes();
    Object.keys(notes).forEach(k => {
        if (k.endsWith(oldSuffix)) { notes[k.slice(0, -oldSuffix.length) + newSuffix] = notes[k]; delete notes[k]; }
    });
    saveMobilityOtherNotes(notes);
    const checks = getMobilityOtherChecks();
    Object.keys(checks).forEach(k => {
        if (k.endsWith(oldSuffix)) { checks[k.slice(0, -oldSuffix.length) + newSuffix] = checks[k]; delete checks[k]; }
    });
    saveMobilityOtherChecks(checks);
}

function renderMobilityOtherList() {
    const list = document.getElementById('mobility-other-list');
    if (!list) return;
    list.innerHTML = '';
    const items = getMobilityOtherLibrary();

    if (items.length === 0) {
        list.innerHTML = '<p class="empty-state">Nothing yet. Add one below.</p>';
        return;
    }

    items.forEach(item => {
        const noteKey = getMobilityOtherNoteKey(item);
        const wrapper = document.createElement('div');
        wrapper.className = 'entry-wrapper';
        const inner = document.createElement('div');
        inner.className = 'entry-inner';

        const row = document.createElement('div');
        row.className = 'sp-entry-row';

        const check = document.createElement('button');
        check.type = 'button';
        check.className = 'mindset-check';
        check.setAttribute('aria-label', 'Mark complete');
        const syncCheck = () => {
            const on = isMobilityOtherChecked(item);
            check.classList.toggle('checked', on);
            check.textContent = on ? '✓' : '';
        };
        syncCheck();

        const title = document.createElement('span');
        title.className = 'sp-entry-topic';
        title.textContent = item;

        const del = document.createElement('button');
        del.className = 'exercise-delete-btn';
        del.textContent = '×';
        del.onclick = (e) => {
            e.stopPropagation();
            if (!del.dataset.confirming) {
                del.dataset.confirming = '1';
                del.textContent = '?';
                del.classList.add('confirming');
                setTimeout(() => { del.textContent = '×'; del.classList.remove('confirming'); delete del.dataset.confirming; }, 2500);
            } else {
                const lib = getMobilityOtherLibrary().filter(b => b !== item);
                saveMobilityOtherLibrary(lib);
                const keyFrag = '__' + item;
                const allNotes = getMobilityOtherNotes();
                Object.keys(allNotes).forEach(k => { if (k.endsWith(keyFrag)) delete allNotes[k]; });
                saveMobilityOtherNotes(allNotes);
                const allChecks = getMobilityOtherChecks();
                Object.keys(allChecks).forEach(k => { if (k.endsWith(keyFrag)) delete allChecks[k]; });
                saveMobilityOtherChecks(allChecks);
                closeOpenPanel(list, () => { renderMobilityOtherList(); refreshChartAfterDataChange(); });
            }
        };

        row.appendChild(check);
        row.appendChild(title);
        row.appendChild(del);

        const panel = document.createElement('div');
        panel.className = 'inline-notes-panel';

        const ta = document.createElement('textarea');
        ta.className = 'sp-notes-input';
        ta.placeholder = 'Notes...';
        ta.value = getMobilityOtherNotes()[noteKey] || '';

        const saveEntry = () => {
            const allNotes = getMobilityOtherNotes();
            const value = ta.value.trim();
            if (value) allNotes[noteKey] = value; else delete allNotes[noteKey];
            saveMobilityOtherNotes(allNotes);
            refreshChartAfterDataChange();
        };
        ta.addEventListener('blur', saveEntry);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ex-close-btn';
        closeBtn.textContent = 'CLOSE';
        closeBtn.onclick = () => {
            saveEntry();
            panel.classList.remove('open');
            row.classList.remove('open');
            list.querySelectorAll('.entry-wrapper').forEach(expandEntryWrapper);
        };

        panel.appendChild(ta);
        panel.appendChild(closeBtn);

        // Long-press to rename
        let pressTimer = null;
        let renameTriggered = false;
        row.addEventListener('contextmenu', e => e.preventDefault());
        row.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.mindset-check')) return;
            if (panel.classList.contains('open')) return;
            renameTriggered = false;
            pressTimer = setTimeout(() => {
                renameTriggered = true;
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'entry-rename-input';
                input.value = item;
                title.replaceWith(input);
                input.focus(); input.select();
                let done = false;
                const commit = (save) => {
                    if (done) return; done = true;
                    const newName = input.value.trim();
                    if (save && newName && newName !== item) {
                        renameMobilityOtherItem(item, newName);
                        renderMobilityOtherList();
                        return;
                    }
                    if (input.parentNode) input.replaceWith(title);
                };
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
                    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
                });
                input.addEventListener('blur', () => commit(true));
                input.addEventListener('click', e => e.stopPropagation());
            }, 600);
        });
        row.addEventListener('pointerup', () => clearTimeout(pressTimer));
        row.addEventListener('pointercancel', () => clearTimeout(pressTimer));

        const openNotesPanel = () => {
            if (panel.classList.contains('open')) { setTimeout(() => ta.focus(), 50); return; }
            list.querySelectorAll('.entry-wrapper').forEach(w => { if (w !== wrapper) collapseEntryWrapper(w); });
            panel.classList.add('open');
            row.classList.add('open');
            setTimeout(() => ta.focus(), 400);
        };

        check.onclick = (e) => {
            e.stopPropagation();
            setMobilityOtherChecked(item, !isMobilityOtherChecked(item));
            syncCheck();
            renderMuscleGrid();
            refreshChartAfterDataChange();
            openNotesPanel();
        };

        row.onclick = (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.mindset-check')) return;
            if (renameTriggered) { renameTriggered = false; return; }
            if (panel.classList.contains('open')) {
                saveEntry();
                panel.classList.remove('open');
                row.classList.remove('open');
                list.querySelectorAll('.entry-wrapper').forEach(expandEntryWrapper);
                return;
            }
            openNotesPanel();
        };

        inner.appendChild(row);
        inner.appendChild(panel);
        wrapper.appendChild(inner);
        list.appendChild(wrapper);
    });
}

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


    const otherBtn = document.createElement('button');
    otherBtn.className = 'muscle-btn';
    if (mobilityOtherHasDataToday()) otherBtn.classList.add('has-data');
    otherBtn.textContent = 'OTHER';
    otherBtn.onclick = () => {
        renderMobilityOtherList();
        showExScreen('ex-screen-mobility-other');
    };
    grid.appendChild(otherBtn);
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


function saveSimpleNotes() {
    const titleEl = document.getElementById('ex-simple-title').textContent;
    const type = MOBILITY_EXTRAS.find(t => t.toUpperCase() === titleEl) || titleEl;
    const notes = getMobilitySimpleNotes();
    notes[getMobilitySimpleKey(type)] = document.getElementById('exSimpleNotes').value.trim();
    saveMobilitySimpleNotes(notes);
    refreshChartAfterDataChange();
}

document.getElementById('closeExerciseModal4').onclick = () => {
    saveSimpleNotes();
    renderMuscleGrid();
    showExScreen('ex-screen-muscles');
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
            if (!del.dataset.confirming) {
                del.dataset.confirming = '1';
                del.textContent = '?';
                del.classList.add('confirming');
                setTimeout(() => { del.textContent = '×'; del.classList.remove('confirming'); delete del.dataset.confirming; }, 2500);
            } else {
                deleteExercise(ex);
            }
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

    const checks = getExerciseChecks();
    const exerciseSuffix = `__${activeMuscle}__${ex}`;
    Object.keys(checks).forEach(k => { if (k.endsWith(exerciseSuffix)) delete checks[k]; });
    saveExerciseChecks(checks);

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
    const headerGroup = document.createElement('div');
    headerGroup.className = 'set-input-group';
    const mkHide = (cls, t) => { const s = document.createElement('span'); s.className = cls; s.textContent = t; s.style.visibility = 'hidden'; return s; };
    const mkLbl  = (t)      => { const s = document.createElement('span'); s.className = 'set-col-label'; s.textContent = t; return s; };
    const emptySetLabel = document.createElement('span');
    emptySetLabel.className = 'set-label';
    header.appendChild(emptySetLabel);
    headerGroup.appendChild(mkHide('set-stepper', '−'));
    headerGroup.appendChild(mkLbl('WEIGHT'));
    headerGroup.appendChild(mkHide('set-stepper', '+'));
    headerGroup.appendChild(mkHide('set-divider', '×'));
    headerGroup.appendChild(mkHide('set-stepper', '−'));
    headerGroup.appendChild(mkLbl('REPS'));
    headerGroup.appendChild(mkHide('set-stepper', '+'));
    header.appendChild(headerGroup);
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
            // Immediately reflect green/not-green on the exercise row in the list
            const anyChecked = current.some(Boolean);
            const list = document.getElementById('exercise-list');
            if (list) {
                list.querySelectorAll('.exercise-row').forEach(r => {
                    const nameEl = r.querySelector('.exercise-row-name');
                    if (nameEl && nameEl.textContent === activeExercise) {
                        r.classList.toggle('has-data', anyChecked);
                    }
                });
            }
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

function saveSets() {
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
}

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
    const rawNote = notes[getExerciseNoteKey(activeMuscle, exercise)] || '';
    document.getElementById('exNotesInput').value = rawNote
        ? rawNote.split('\n').map(l => l && !l.startsWith('• ') ? '• ' + l : l).join('\n')
        : '• ';
    showExScreen('ex-screen-ex-notes');
    setTimeout(() => {
        const ta = document.getElementById('exNotesInput');
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
    }, 50);
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

function saveExerciseNote() {
    const notes = getExerciseNotes();
    const value = document.getElementById('exNotesInput').value.trim();
    notes[getExerciseNoteKey(activeMuscle, activeExercise)] =
        /^[•\s]*$/.test(value) ? '' : value;
    saveExerciseNotes(notes);
}

document.getElementById('exNotesInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + '\n• ' + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = start + 3;
});

document.getElementById('closeExerciseModal5').onclick = () => {
    saveExerciseNote();
    showExScreen('ex-screen-sets');
};

document.getElementById('closeExerciseModal2').onclick = () => {
    renderMuscleGrid();
    showExScreen('ex-screen-muscles');
};
document.getElementById('closeMobilityOther').onclick = () => {
    renderMuscleGrid();
    showExScreen('ex-screen-muscles');
};
document.getElementById('mobilityOtherAddBtn').onclick = () => {
    const input = document.getElementById('mobilityOtherInput');
    const name  = input.value.trim();
    if (!name) return;
    const lib = getMobilityOtherLibrary();
    if (!lib.map(b => b.toLowerCase()).includes(name.toLowerCase())) {
        lib.push(name);
        saveMobilityOtherLibrary(lib);
    }
    input.value = '';
    const list = document.getElementById('mobility-other-list');
    closeOpenPanel(list, () => {
        renderMobilityOtherList();
        const wrappers = list.querySelectorAll('.entry-wrapper');
        const newest = wrappers[wrappers.length - 1];
        if (newest) {
            newest.classList.add('entry-collapsing');
            requestAnimationFrame(() => requestAnimationFrame(() => newest.classList.remove('entry-collapsing')));
        }
    });
};
document.getElementById('mobilityOtherInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('mobilityOtherAddBtn').click();
});
document.getElementById('closeExerciseModal3').onclick = () => {
    saveSets();
    showExScreen('ex-screen-exercises');
};


document.getElementById('closeExerciseModal').onclick = () => {
    document.getElementById('exerciseModal').style.display = 'none';
};


window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ['exerciseModal','spiritualModal','mindfulnessModal','recoveryModal','reflectionModal','mindsetModal']
            .forEach(id => document.getElementById(id).style.display = 'none');
    }
});


function openSpiritualModal() {
    openJournalModal('spiritual');
}

const JOURNAL_CONFIGS = {
    spiritual: { key: 'spiritual_entries', modalId: 'spiritualModal', prefix: 'sp' },
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
    [p + '-screen-list', p + '-screen-notes'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

function collapseEntryWrapper(w) {
    w.classList.add('entry-collapsing');
}

function expandEntryWrapper(w) {
    w.classList.remove('entry-collapsing');
}

function closeOpenPanel(list, callback) {
    const panel = list.querySelector('.inline-notes-panel.open');
    if (!panel) { callback(); return; }
    panel.classList.remove('open');
    panel.previousElementSibling?.classList.remove('open');
    list.querySelectorAll('.entry-wrapper').forEach(expandEntryWrapper);
    setTimeout(callback, 420);
}

function renderJournalList(type) {
    const cfg = JOURNAL_CONFIGS[type];
    const list = document.getElementById(cfg.prefix + '-entry-list');
    list.innerHTML = '';
    const entries = getJournalEntries(type);
    const isInline = ['mindfulness', 'recovery', 'reflection', 'spiritual'].includes(type);

    if (entries.length === 0) {
        list.innerHTML = '<p class="empty-state">No entries yet.</p>';
        return;
    }
    entries.forEach((entry, idx) => {
        const wrapper = document.createElement('div');

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
            if (!del.dataset.confirming) {
                del.dataset.confirming = '1';
                del.textContent = '?';
                del.classList.add('confirming');
                setTimeout(() => { del.textContent = '×'; del.classList.remove('confirming'); delete del.dataset.confirming; }, 2500);
            } else {
                const all = getJournalEntries(type);
                all.splice(idx, 1);
                saveJournalEntries(type, all);
                renderJournalList(type);
                refreshChartAfterDataChange();
            }
        };
        row.appendChild(topic);
        row.appendChild(del);

        if (isInline) {
            wrapper.className = 'entry-wrapper';
            const inner = document.createElement('div');
            inner.className = 'entry-inner';

            const panel = document.createElement('div');
            panel.className = 'inline-notes-panel';

            const ta = document.createElement('textarea');
            ta.className = 'sp-notes-input';
            ta.placeholder = 'Notes...';
            ta.value = entry.notes || '';

            const saveEntry = () => {
                const all = getJournalEntries(type);
                if (all[idx] !== undefined) {
                    all[idx].notes = ta.value.trim();
                    saveJournalEntries(type, all);
                    refreshChartAfterDataChange();
                }
            };
            ta.addEventListener('blur', saveEntry);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'ex-close-btn';
            closeBtn.textContent = 'CLOSE';
            closeBtn.onclick = () => {
                saveEntry();
                panel.classList.remove('open');
                row.classList.remove('open');
                list.querySelectorAll('.entry-wrapper').forEach(expandEntryWrapper);
            };

            panel.appendChild(ta);
            panel.appendChild(closeBtn);

            // Long-press to rename
            let pressTimer = null;
            let renameTriggered = false;
            row.addEventListener('contextmenu', e => e.preventDefault());
            row.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.exercise-delete-btn')) return;
                if (panel.classList.contains('open')) return;
                renameTriggered = false;
                pressTimer = setTimeout(() => {
                    renameTriggered = true;
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'entry-rename-input';
                    input.value = entry.topic || '';
                    topic.replaceWith(input);
                    input.focus(); input.select();
                    let done = false;
                    const commit = (save) => {
                        if (done) return; done = true;
                        const newName = input.value.trim();
                        if (save && newName && newName !== (entry.topic || '')) {
                            const all = getJournalEntries(type);
                            if (all[idx] !== undefined) {
                                all[idx].topic = newName;
                                entry.topic = newName;
                                saveJournalEntries(type, all);
                                topic.textContent = newName;
                            }
                        }
                        if (input.parentNode) input.replaceWith(topic);
                    };
                    input.addEventListener('keydown', e => {
                        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
                        else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
                    });
                    input.addEventListener('blur', () => commit(true));
                    input.addEventListener('click', e => e.stopPropagation());
                }, 600);
            });
            row.addEventListener('pointerup', () => clearTimeout(pressTimer));
            row.addEventListener('pointercancel', () => clearTimeout(pressTimer));

            row.onclick = (e) => {
                if (e.target.closest('.exercise-delete-btn')) return;
                if (renameTriggered) { renameTriggered = false; return; }
                const isOpen = panel.classList.contains('open');
                if (isOpen) {
                    saveEntry();
                    panel.classList.remove('open');
                    row.classList.remove('open');
                    list.querySelectorAll('.entry-wrapper').forEach(expandEntryWrapper);
                    return;
                }
                list.querySelectorAll('.entry-wrapper').forEach(w => {
                    if (w !== wrapper) collapseEntryWrapper(w);
                });
                panel.classList.add('open');
                row.classList.add('open');
                setTimeout(() => ta.focus(), 400);
            };

            inner.appendChild(row);
            inner.appendChild(panel);
            wrapper.appendChild(inner);
        } else {
            row.onclick = () => openJournalNotes(type, idx);
            wrapper.appendChild(row);
        }

        list.appendChild(wrapper);
    });
}

function openJournalNotes(type, idx) {
    activeJournalType = type;
    activeJournalEntryId = idx;
    const entries = getJournalEntries(type);
    const entry = entries[idx] || { topic: '', notes: '' };
    const p = JOURNAL_CONFIGS[type].prefix;
    const titleEl = document.getElementById(p + '-entry-title');
    titleEl.textContent = (entry.topic || 'Untitled').toUpperCase();
    document.getElementById(p + 'NotesInput').value = entry.notes || '';
    makeTitleEditable(
        titleEl,
        () => {
            const e = getJournalEntries(type)[activeJournalEntryId];
            return e ? e.topic || '' : '';
        },
        (newName) => {
            const all = getJournalEntries(type);
            if (all[activeJournalEntryId] !== undefined) {
                all[activeJournalEntryId].topic = newName;
                saveJournalEntries(type, all);
                renderJournalList(type);
            }
        }
    );
    showJournalScreen(p + '-screen-notes');
    setTimeout(() => document.getElementById(p + 'NotesInput').focus(), 50);
}


Object.entries(JOURNAL_CONFIGS).forEach(([type, cfg]) => {
    const p = cfg.prefix;

    document.getElementById(p + 'AddEntryBtn').onclick = () => {
        const input = document.getElementById(p + 'NewEntryInput');
        const name = input.value.trim();
        if (!name) return;
        const entries = getJournalEntries(type);
        entries.push({ topic: name, notes: '' });
        saveJournalEntries(type, entries);
        input.value = '';
        const list = document.getElementById(cfg.prefix + '-entry-list');
        closeOpenPanel(list, () => {
            renderJournalList(type);
            const wrappers = list.querySelectorAll('.entry-wrapper');
            const newest = wrappers[wrappers.length - 1];
            if (newest) {
                newest.classList.add('entry-collapsing');
                requestAnimationFrame(() => requestAnimationFrame(() => newest.classList.remove('entry-collapsing')));
            }
        });
    };

    document.getElementById(p + 'NewEntryInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById(p + 'AddEntryBtn').click();
    });

    const saveNotes = () => {
        const entries = getJournalEntries(type);
        if (activeJournalEntryId !== null && entries[activeJournalEntryId] !== undefined) {
            entries[activeJournalEntryId].notes = document.getElementById(p + 'NotesInput').value.trim();
            saveJournalEntries(type, entries);
            refreshChartAfterDataChange();
        }
    };

    document.getElementById(p + 'CloseNotes').onclick = () => {
        saveNotes();
        document.getElementById(cfg.modalId).style.display = 'none';
    };

    const base = type.charAt(0).toUpperCase() + type.slice(1);
    document.getElementById('close' + base + 'Modal').onclick = () => {
        document.getElementById(cfg.modalId).style.display = 'none';
    };
});


// ─── Recovery Modal ───────────────────────────────────────────────────────────
const RECOVERY_KEY = 'recovery_data';

function formatSleepVal(val) {
    const h = Math.floor(val);
    const m = Math.round((val - h) * 60);
    return m === 0 ? `${h} HRS` : `${h}:${String(m).padStart(2, '0')} HRS`;
}

function getRecoveryData() {
    const raw = Storage.getItem(RECOVERY_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] || {};
}
function saveRecoveryData(data) {
    const raw = Storage.getItem(RECOVERY_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const hasAny = data.nutrition != null || data.hydration || data.cryotherapy || data.sleep != null;
    if (hasAny) {
        all[getDateKey(viewDate)] = data;
    } else {
        delete all[getDateKey(viewDate)];
    }
    Storage.setItem(RECOVERY_KEY, JSON.stringify(all));
}

function openRecoveryModal() {
    renderRecoveryButtons();
    const data = getRecoveryData();
    const nutrition = data.nutrition != null ? data.nutrition : 3000;
    const sleep = data.sleep != null ? data.sleep : 8;
    document.getElementById('rc-nutrition-range').value = nutrition;
    document.getElementById('rc-nutrition-value').textContent = nutrition + ' CAL';
    document.getElementById('rc-sleep-range').value = sleep;
    document.getElementById('rc-sleep-value').textContent = formatSleepVal(sleep);
    document.getElementById('recoveryModal').style.display = 'flex';
}

function renderRecoveryButtons() {
    const data = getRecoveryData();
    ['hydration', 'cryotherapy'].forEach(key => {
        const btn = document.getElementById('rc-btn-' + key);
        if (btn) btn.classList.toggle('has-data', !!data[key]);
    });
}

['hydration', 'cryotherapy'].forEach(key => {
    document.getElementById('rc-btn-' + key).onclick = () => {
        const data = getRecoveryData();
        if (data[key]) { delete data[key]; } else { data[key] = true; }
        saveRecoveryData(data);
        renderRecoveryButtons();
        refreshChartAfterDataChange();
    };
});

document.getElementById('rc-nutrition-range').addEventListener('input', () => {
    const val = parseInt(document.getElementById('rc-nutrition-range').value);
    document.getElementById('rc-nutrition-value').textContent = val + ' CAL';
    const data = getRecoveryData();
    data.nutrition = val;
    saveRecoveryData(data);
    refreshChartAfterDataChange();
});

document.getElementById('rc-sleep-range').addEventListener('input', () => {
    const val = parseFloat(document.getElementById('rc-sleep-range').value);
    document.getElementById('rc-sleep-value').textContent = formatSleepVal(val);
    const data = getRecoveryData();
    data.sleep = val;
    saveRecoveryData(data);
    refreshChartAfterDataChange();
});

document.getElementById('closeRecoveryModal').onclick = () => {
    document.getElementById('recoveryModal').style.display = 'none';
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── REFLECTION 3-2-1 ────────────────────────────────────────────────────────
const RF_SECTIONS = { happy: 5, grateful: 3, learned: 2, better: 1 };

function getRfData() {
    const raw = Storage.getItem('reflection_321');
    const all = raw ? JSON.parse(raw) : {};
    const day = all[getDateKey(viewDate)] || {};
    return {
        happy:    day.happy    || ['', '', '', '', ''],
        grateful: day.grateful || ['', '', ''],
        learned:  day.learned  || ['', ''],
        better:   day.better   || [''],
    };
}

function saveRfData(data) {
    const raw = Storage.getItem('reflection_321');
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = data;
    Storage.setItem('reflection_321', JSON.stringify(all));
}

function updateRfSectionStyle(section, data) {
    const hasContent = data[section].some(v => v.trim());
    document.getElementById('rf-sec-' + section).classList.toggle('rf-has-content', hasContent);
}

function openReflectionModal() {
    const data = getRfData();
    Object.keys(RF_SECTIONS).forEach(section => {
        data[section].forEach((val, i) => {
            document.getElementById('rf-' + section + '-' + i).value = val;
        });
        updateRfSectionStyle(section, data);
        // reset chevron + collapse all on open
        const hdr = document.getElementById('rf-hdr-' + section);
        const body = document.getElementById('rf-body-' + section);
        hdr.classList.remove('rf-open');
        body.classList.remove('rf-body-open');
    });
    document.getElementById('reflectionModal').style.display = 'flex';
}

Object.entries(RF_SECTIONS).forEach(([section, count]) => {
    document.getElementById('rf-hdr-' + section).addEventListener('click', () => {
        const body = document.getElementById('rf-body-' + section);
        const hdr  = document.getElementById('rf-hdr-' + section);
        const opening = !body.classList.contains('rf-body-open');

        const anyOpen = Object.keys(RF_SECTIONS).some(s =>
            document.getElementById('rf-body-' + s).classList.contains('rf-body-open')
        );

        Object.keys(RF_SECTIONS).forEach(s => {
            document.getElementById('rf-body-' + s).classList.remove('rf-body-open');
            document.getElementById('rf-hdr-' + s).classList.remove('rf-open');
        });

        if (opening) {
            setTimeout(() => {
                body.classList.add('rf-body-open');
                hdr.classList.add('rf-open');
                setTimeout(() => document.getElementById('rf-' + section + '-0').focus(), 50);
            }, anyOpen ? 320 : 0);
        }
    });

    for (let i = 0; i < count; i++) {
        const input = document.getElementById('rf-' + section + '-' + i);

        input.addEventListener('input', (e) => {
            const data = getRfData();
            data[section][i] = e.target.value;
            saveRfData(data);
            updateRfSectionStyle(section, data);
            refreshChartAfterDataChange();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (i < count - 1) {
                document.getElementById('rf-' + section + '-' + (i + 1)).focus();
            } else {
                const sections = Object.keys(RF_SECTIONS);
                const nextSection = sections[sections.indexOf(section) + 1];
                document.getElementById('rf-body-' + section).classList.remove('rf-body-open');
                document.getElementById('rf-hdr-' + section).classList.remove('rf-open');
                if (nextSection) {
                    document.getElementById('rf-body-' + nextSection).classList.add('rf-body-open');
                    document.getElementById('rf-hdr-' + nextSection).classList.add('rf-open');
                    setTimeout(() => document.getElementById('rf-' + nextSection + '-0').focus(), 50);
                }
            }
        });
    }
});

document.getElementById('closeReflectionModal').onclick = () => {
    document.getElementById('reflectionModal').style.display = 'none';
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── MINDFULNESS CLOCK ───────────────────────────────────────────────────────
function getMfMinutes() {
    const raw = Storage.getItem('mindfulness_minutes');
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] || 0;
}
function saveMfMinutes(minutes) {
    const raw = Storage.getItem('mindfulness_minutes');
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = minutes;
    Storage.setItem('mindfulness_minutes', JSON.stringify(all));
}
function getMfBreathing() {
    const raw = Storage.getItem('mindfulness_breathing');
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] ?? 5;
}
function saveMfBreathing(val) {
    const raw = Storage.getItem('mindfulness_breathing');
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = val;
    Storage.setItem('mindfulness_breathing', JSON.stringify(all));
}
function getMfFocus() {
    const raw = Storage.getItem('mindfulness_focus');
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] ?? 5;
}
function saveMfFocus(val) {
    const raw = Storage.getItem('mindfulness_focus');
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = val;
    Storage.setItem('mindfulness_focus', JSON.stringify(all));
}

let mfDragging = false;
let mfTotalDeg = 0;
let mfLastAngleDeg = 0;

function getMfAngleDeg(e) {
    const svg = document.getElementById('mfClock');
    const rect = svg.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    return (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
}

function updateMfClockDisplay(minutes) {
    const svg = document.getElementById('mfClock');
    if (!svg) return;
    const cx = 100, cy = 100, handR = 72;
    const angle = (minutes / 60) * 2 * Math.PI - Math.PI / 2;
    const hx = cx + handR * Math.cos(angle);
    const hy = cy + handR * Math.sin(angle);

    const hand = document.getElementById('mfHand');
    if (hand) { hand.setAttribute('x2', hx); hand.setAttribute('y2', hy); hand.setAttribute('opacity', minutes > 0 ? '1' : '0.2'); }


    const progress = document.getElementById('mfProgress');
    if (progress) {
        const circumference = 2 * Math.PI * 78;
        progress.setAttribute('stroke-dashoffset', circumference * (1 - minutes / 60));
        progress.setAttribute('opacity', minutes > 0 ? '0.6' : '0');
    }

    const minText = document.getElementById('mfMinText');
    if (minText) minText.textContent = minutes + ' MIN';
}

function initMfClock() {
    const svg = document.getElementById('mfClock');
    if (!svg) return;
    svg.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    const cx = 100, cy = 100, r = 90, trackR = 78;

    const bg = document.createElementNS(ns, 'circle');
    bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', r);
    bg.setAttribute('fill', '#141414'); bg.setAttribute('stroke', 'rgba(255,255,255,0.07)'); bg.setAttribute('stroke-width', '1');
    svg.appendChild(bg);

    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('cx', cx); track.setAttribute('cy', cy); track.setAttribute('r', trackR);
    track.setAttribute('fill', 'none'); track.setAttribute('stroke', '#1c1c1c'); track.setAttribute('stroke-width', '5');
    svg.appendChild(track);

    const circumference = 2 * Math.PI * trackR;
    const progress = document.createElementNS(ns, 'circle');
    progress.setAttribute('id', 'mfProgress');
    progress.setAttribute('cx', cx); progress.setAttribute('cy', cy); progress.setAttribute('r', trackR);
    progress.setAttribute('fill', 'none'); progress.setAttribute('stroke', '#c9a96e'); progress.setAttribute('stroke-width', '5');
    progress.setAttribute('stroke-linecap', 'round');
    progress.setAttribute('stroke-dasharray', circumference); progress.setAttribute('stroke-dashoffset', circumference);
    progress.setAttribute('transform', `rotate(-90 ${cx} ${cy})`); progress.setAttribute('opacity', '0');
    svg.appendChild(progress);

    for (let i = 0; i < 60; i++) {
        const angle = (i / 60) * Math.PI * 2 - Math.PI / 2;
        const isMajor = i % 5 === 0;
        const r1 = r - (isMajor ? 13 : 7);
        const r2 = r - 3;
        const tick = document.createElementNS(ns, 'line');
        tick.setAttribute('x1', cx + r1 * Math.cos(angle)); tick.setAttribute('y1', cy + r1 * Math.sin(angle));
        tick.setAttribute('x2', cx + r2 * Math.cos(angle)); tick.setAttribute('y2', cy + r2 * Math.sin(angle));
        tick.setAttribute('stroke', isMajor ? 'rgba(201,169,110,0.45)' : 'rgba(255,255,255,0.08)');
        tick.setAttribute('stroke-width', isMajor ? '1.5' : '0.8');
        svg.appendChild(tick);

        if (isMajor) {
            const label = document.createElementNS(ns, 'text');
            const lr = r - 30;
            label.setAttribute('x', cx + lr * Math.cos(angle)); label.setAttribute('y', cy + lr * Math.sin(angle));
            label.setAttribute('text-anchor', 'middle'); label.setAttribute('dominant-baseline', 'central');
            label.setAttribute('fill', 'rgba(240,236,228,0.45)'); label.setAttribute('font-size', '11'); label.setAttribute('font-family', 'monospace');
            label.textContent = i === 0 ? 60 : i;
            svg.appendChild(label);
        }
    }

    const boxRect = document.createElementNS(ns, 'rect');
    boxRect.setAttribute('id', 'mfMinRect');
    boxRect.setAttribute('x', '74'); boxRect.setAttribute('y', '118');
    boxRect.setAttribute('width', '52'); boxRect.setAttribute('height', '16');
    boxRect.setAttribute('rx', '3');
    boxRect.setAttribute('fill', '#141414'); boxRect.setAttribute('stroke', 'rgba(255,255,255,0.07)');
    svg.appendChild(boxRect);

    const boxText = document.createElementNS(ns, 'text');
    boxText.setAttribute('id', 'mfMinText');
    boxText.setAttribute('x', '100'); boxText.setAttribute('y', '126');
    boxText.setAttribute('text-anchor', 'middle'); boxText.setAttribute('dominant-baseline', 'central');
    boxText.setAttribute('fill', '#c9a96e'); boxText.setAttribute('font-size', '7.5');
    boxText.setAttribute('font-family', 'monospace'); boxText.setAttribute('letter-spacing', '1.5');
    boxText.textContent = '0 MIN';
    svg.appendChild(boxText);

    const hand = document.createElementNS(ns, 'line');
    hand.setAttribute('id', 'mfHand');
    hand.setAttribute('x1', cx); hand.setAttribute('y1', cy); hand.setAttribute('x2', cx); hand.setAttribute('y2', cy - 72);
    hand.setAttribute('stroke', '#c9a96e'); hand.setAttribute('stroke-width', '2'); hand.setAttribute('stroke-linecap', 'round'); hand.setAttribute('opacity', '0.2');
    svg.appendChild(hand);

    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', '4');
    dot.setAttribute('fill', '#c9a96e');
    svg.appendChild(dot);

    svg.addEventListener('pointerdown', (e) => {
        mfDragging = true;
        svg.setPointerCapture(e.pointerId);
        mfLastAngleDeg = getMfAngleDeg(e);
        e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
        if (!mfDragging) return;
        const angle = getMfAngleDeg(e);
        let delta = angle - mfLastAngleDeg;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        mfTotalDeg = Math.max(0, Math.min(360, mfTotalDeg + delta));
        mfLastAngleDeg = angle;
        updateMfClockDisplay(Math.round(mfTotalDeg / 6));
    });
    svg.addEventListener('pointerup', () => {
        if (!mfDragging) return;
        mfDragging = false;
        const minutes = Math.round(mfTotalDeg / 6);
        saveMfMinutes(minutes);
        refreshChartAfterDataChange();
    });
    svg.addEventListener('pointercancel', () => { mfDragging = false; });
}

function openMindfulnessModal() {
    mfTotalDeg = (getMfMinutes() / 60) * 360;
    updateMfClockDisplay(Math.round(mfTotalDeg / 6));

    const breathing = getMfBreathing();
    const focus = getMfFocus();
    document.getElementById('mf-breath-slider').value = breathing;
    document.getElementById('mf-breath-val').textContent = breathing;
    document.getElementById('mf-focus-slider').value = focus;
    document.getElementById('mf-focus-val').textContent = focus;

    document.getElementById('mindfulnessModal').style.display = 'flex';
}

document.getElementById('closeMindfulnessModal').onclick = () => {
    document.getElementById('mindfulnessModal').style.display = 'none';
};

document.getElementById('mf-breath-slider').addEventListener('input', () => {
    const val = parseInt(document.getElementById('mf-breath-slider').value);
    document.getElementById('mf-breath-val').textContent = val;
    saveMfBreathing(val);
});

document.getElementById('mf-focus-slider').addEventListener('input', () => {
    const val = parseInt(document.getElementById('mf-focus-slider').value);
    document.getElementById('mf-focus-val').textContent = val;
    saveMfFocus(val);
});

initMfClock();
// ─────────────────────────────────────────────────────────────────────────────

const MINDSET_NOTES_KEY = 'mindset_notes';
const MINDSET_CHECKS_KEY = 'mindset_checks';
const MINDSET_TYPE_LABELS = { book: 'BOOKS', video: 'VIDEOS', podcast: 'PODCASTS', conversation: 'CONVERSATIONS' };
const MINDSET_TYPE_PLACEHOLDERS = { book: 'Add book...', video: 'Add video...', podcast: 'Add podcast...', conversation: 'Add conversation...' };
let activeMindsetType = null;
let activeBook = null;

function getMindsetLibraryForType(type) {
    // Per-day key for the date currently being viewed.
    const dateKey  = getDateKey(viewDate);
    const perDayKey = 'mindset_library__' + type + '__' + dateKey;
    const perDayRaw = Storage.getItem(perDayKey);
    if (perDayRaw) return JSON.parse(perDayRaw);

    // Future day with no own library: inherit from today's per-day library so
    // whatever is current today shows up on future days automatically.
    const todayKey = getDateKey(new Date());
    if (dateKey > todayKey) {
        const todayPerDay = Storage.getItem('mindset_library__' + type + '__' + todayKey);
        if (todayPerDay) return JSON.parse(todayPerDay);
    }

    // Past day or no per-day data: fall back to the legacy global key.
    // This key is intentionally never written to again, so past days always
    // see the library as it was before per-day tracking was introduced.
    const raw = Storage.getItem('mindset_library__' + type);
    return raw ? JSON.parse(raw) : [];
}
function saveMindsetLibraryForType(type, lib) {
    // Write only to the current day's per-day key.
    // The legacy global key is left untouched so past days keep their snapshot.
    const dateKey = getDateKey(viewDate);
    Storage.setItem('mindset_library__' + type + '__' + dateKey, JSON.stringify(lib));
}
function getMindsetNotes() {
    const raw = Storage.getItem('mindset_notes');
    return raw ? JSON.parse(raw) : {};
}
function saveMindsetNotes(notes) {
    Storage.setItem('mindset_notes', JSON.stringify(notes));
}

// Per-day check marks. Same key shape as notes (date__type__item) so the
// existing rename function can migrate them with a small addition.
function getMindsetChecks() {
    const raw = Storage.getItem('mindset_checks');
    return raw ? JSON.parse(raw) : {};
}
function saveMindsetChecks(checks) {
    Storage.setItem('mindset_checks', JSON.stringify(checks));
}
function isMindsetItemChecked(type, item) {
    return !!getMindsetChecks()[getMindsetNoteKey(type, item)];
}
function setMindsetItemChecked(type, item, checked) {
    const checks = getMindsetChecks();
    const key = getMindsetNoteKey(type, item);
    if (checked) checks[key] = true;
    else delete checks[key];
    saveMindsetChecks(checks);
}
function getMindsetNoteKey(type, item) {
    return getDateKey(viewDate) + '__' + type + '__' + item;
}

// Whether a given mindset type has activity (check OR note) for the current
// viewDate. Library presence alone does NOT count anymore — items now persist
// across days, so the green label needs an explicit signal that the user
// engaged with something today.
function mindsetTypeHasDataToday(type) {
    const dayPrefix = getDateKey(viewDate) + '__' + type + '__';
    const notes = getMindsetNotes();
    if (Object.keys(notes).some(k => k.startsWith(dayPrefix) && notes[k])) return true;
    const checks = getMindsetChecks();
    if (Object.keys(checks).some(k => k.startsWith(dayPrefix) && checks[k])) return true;
    return false;
}

function renderMindsetTypeButtons() {
    ['book', 'video', 'podcast', 'conversation'].forEach(type => {
        const btn = document.getElementById('ms-btn-' + type);
        if (btn) btn.classList.toggle('has-data', mindsetTypeHasDataToday(type));
    });
}

function openMindsetModal() {
    renderMindsetTypeButtons();
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

    if (items.length === 0) {
        list.innerHTML = '<p class="empty-state">Nothing yet. Add one below.</p>';
        return;
    }
    items.forEach(item => {
        const noteKey = getMindsetNoteKey(activeMindsetType, item);
        const wrapper = document.createElement('div');

        const row = document.createElement('div');
        row.className = 'sp-entry-row';

        // Per-day checkbox. Tapping it toggles the check AND opens the notes
        // panel (same behavior as tapping the row itself), so the user can
        // mark something done and jot a note in one motion.
        const check = document.createElement('button');
        check.type = 'button';
        check.className = 'mindset-check';
        check.setAttribute('aria-label', 'Mark complete');
        const syncCheck = () => {
            const isChecked = isMindsetItemChecked(activeMindsetType, item);
            check.classList.toggle('checked', isChecked);
            check.textContent = isChecked ? '✓' : '';
        };
        syncCheck();

        const title = document.createElement('span');
        title.className = 'sp-entry-topic';
        title.textContent = item;

        const del = document.createElement('button');
        del.className = 'exercise-delete-btn';
        del.textContent = '×';
        del.onclick = (e) => {
            e.stopPropagation();
            if (!del.dataset.confirming) {
                del.dataset.confirming = '1';
                del.textContent = '?';
                del.classList.add('confirming');
                setTimeout(() => { del.textContent = '×'; del.classList.remove('confirming'); delete del.dataset.confirming; }, 2500);
            } else {
                const lib = getMindsetLibraryForType(activeMindsetType).filter(b => b !== item);
                saveMindsetLibraryForType(activeMindsetType, lib);
                const keyFragment = '__' + activeMindsetType + '__' + item;
                const allNotes = getMindsetNotes();
                Object.keys(allNotes).forEach(k => { if (k.endsWith(keyFragment)) delete allNotes[k]; });
                saveMindsetNotes(allNotes);
                const allChecks = getMindsetChecks();
                Object.keys(allChecks).forEach(k => { if (k.endsWith(keyFragment)) delete allChecks[k]; });
                saveMindsetChecks(allChecks);
                const list = document.getElementById('ms-book-list');
                closeOpenPanel(list, () => {
                    renderBookList();
                    refreshChartAfterDataChange();
                });
            }
        };

        row.appendChild(check);
        row.appendChild(title);
        row.appendChild(del);

        wrapper.className = 'entry-wrapper';
        const inner = document.createElement('div');
        inner.className = 'entry-inner';

        const panel = document.createElement('div');
        panel.className = 'inline-notes-panel';

        const ta = document.createElement('textarea');
        ta.className = 'sp-notes-input';
        ta.placeholder = 'Notes...';
        ta.value = getMindsetNotes()[noteKey] || '';

        const saveEntry = () => {
            const allNotes = getMindsetNotes();
            const value = ta.value.trim();
            if (value) allNotes[noteKey] = value;
            else delete allNotes[noteKey];
            saveMindsetNotes(allNotes);
            refreshChartAfterDataChange();
        };
        ta.addEventListener('blur', saveEntry);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ex-close-btn';
        closeBtn.textContent = 'CLOSE';
        closeBtn.onclick = () => {
            saveEntry();
            panel.classList.remove('open');
            row.classList.remove('open');
            list.querySelectorAll('.entry-wrapper').forEach(expandEntryWrapper);
        };

        panel.appendChild(ta);
        panel.appendChild(closeBtn);

        // Long-press to rename
        let pressTimer = null;
        let renameTriggered = false;
        row.addEventListener('contextmenu', e => e.preventDefault());
        row.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.mindset-check')) return;
            if (panel.classList.contains('open')) return;
            renameTriggered = false;
            pressTimer = setTimeout(() => {
                renameTriggered = true;
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'entry-rename-input';
                input.value = item;
                title.replaceWith(input);
                input.focus(); input.select();
                let done = false;
                const commit = (save) => {
                    if (done) return; done = true;
                    const newName = input.value.trim();
                    if (save && newName && newName !== item) {
                        renameMindsetItem(activeMindsetType, item, newName);
                        renderBookList();
                        return;
                    }
                    if (input.parentNode) input.replaceWith(title);
                };
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
                    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
                });
                input.addEventListener('blur', () => commit(true));
                input.addEventListener('click', e => e.stopPropagation());
            }, 600);
        });
        row.addEventListener('pointerup', () => clearTimeout(pressTimer));
        row.addEventListener('pointercancel', () => clearTimeout(pressTimer));

        // Open the inline notes panel (if not already open). Reused by both
        // the row click and the checkbox click.
        const openNotesPanel = () => {
            if (panel.classList.contains('open')) {
                setTimeout(() => ta.focus(), 50);
                return;
            }
            list.querySelectorAll('.entry-wrapper').forEach(w => {
                if (w !== wrapper) collapseEntryWrapper(w);
            });
            panel.classList.add('open');
            row.classList.add('open');
            setTimeout(() => ta.focus(), 400);
        };

        // Checkbox: toggle per-day check and open the notes panel.
        // stopPropagation prevents the row's own click handler from firing.
        check.onclick = (e) => {
            e.stopPropagation();
            const newState = !isMindsetItemChecked(activeMindsetType, item);
            setMindsetItemChecked(activeMindsetType, item, newState);
            syncCheck();
            refreshChartAfterDataChange();
            openNotesPanel();
        };

        row.onclick = (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.mindset-check')) return;
            if (renameTriggered) { renameTriggered = false; return; }
            const isOpen = panel.classList.contains('open');
            if (isOpen) {
                saveEntry();
                panel.classList.remove('open');
                row.classList.remove('open');
                list.querySelectorAll('.entry-wrapper').forEach(expandEntryWrapper);
                return;
            }
            openNotesPanel();
        };

        inner.appendChild(row);
        inner.appendChild(panel);
        wrapper.appendChild(inner);
        list.appendChild(wrapper);
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
// any existing notes AND checks to the new key, in the active type's library.
function renameMindsetItem(type, oldName, newName) {
    if (oldName === newName) return;
    // 1) library
    const lib = getMindsetLibraryForType(type);
    const idx = lib.indexOf(oldName);
    if (idx >= 0) {
        lib[idx] = newName;
        saveMindsetLibraryForType(type, lib);
    }
    const oldSuffix = '__' + type + '__' + oldName;
    const newSuffix = '__' + type + '__' + newName;
    // 2) notes (migrate every date that had a note for this item)
    const notes = getMindsetNotes();
    Object.keys(notes).forEach(k => {
        if (k.endsWith(oldSuffix)) {
            const datePart = k.slice(0, k.length - oldSuffix.length);
            notes[datePart + newSuffix] = notes[k];
            delete notes[k];
        }
    });
    saveMindsetNotes(notes);
    // 3) checks (same migration shape)
    const checks = getMindsetChecks();
    Object.keys(checks).forEach(k => {
        if (k.endsWith(oldSuffix)) {
            const datePart = k.slice(0, k.length - oldSuffix.length);
            checks[datePart + newSuffix] = checks[k];
            delete checks[k];
        }
    });
    saveMindsetChecks(checks);
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
    const list = document.getElementById('ms-book-list');
    closeOpenPanel(list, () => {
        renderBookList();
        const wrappers = list.querySelectorAll('.entry-wrapper');
        const newest = wrappers[wrappers.length - 1];
        if (newest) {
            newest.classList.add('entry-collapsing');
            requestAnimationFrame(() => requestAnimationFrame(() => newest.classList.remove('entry-collapsing')));
        }
    });
};
document.getElementById('newBookInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('addBookBtn').click();
});

function saveMindsetNote() {
    const notes = getMindsetNotes();
    notes[getMindsetNoteKey(activeMindsetType, activeBook)] = document.getElementById('msBookNotes').value.trim();
    saveMindsetNotes(notes);
    refreshChartAfterDataChange();
}

document.getElementById('closeMsNotes').onclick = () => {
    saveMindsetNote();
    showMsScreen('ms-screen-books');
};
document.getElementById('closeMsBooks').onclick = () => {
    renderMindsetTypeButtons();
    showMsScreen('ms-screen-type');
};

document.getElementById('closeMindsetModal').onclick = () => {
    document.getElementById('mindsetModal').style.display = 'none';
};

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
    if (activeAvoidedActivity) {
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
    }
    document.getElementById('avoidedModal').style.display = 'none';
    activeAvoidedActivity = null;
}

document.getElementById('closeAvoidedModal').addEventListener('click', closeAvoidedModal);


window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const av = document.getElementById('avoidedModal');
        if (av && av.style.display === 'flex') { av.style.display = 'none'; activeAvoidedActivity = null; }
    }
});