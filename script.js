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
//                 /           \
//             [6]               [1]
//            /                     \
//          [5]                     [2]
//            \                     /
//             [4]               [3]
//                 \           /
//                   (bottom)
//
// To reorder labels, just rearrange the items in this array.
// The "value" is the default starting value (out of 10) for an untouched dot.
const defaultValues = [
    { name: 'Spirituality', value: 2, note: '' },
    { name: 'Recovery', value: 2, note: '' },
    { name: 'Mindset', value: 2, note: '' },
    { name: 'Mindfulness', value: 0, note: '' },
    { name: 'Reflection', value: 2, note: '' },
    { name: 'Mobility', value: 2, note: '' },
    { name: 'Creativity', value: 2, note: '' }
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

// Sin/virtue levels are stored per-day: { "YYYY-MM-DD": { activity: value } }
// When reading a day with no entry, fall back to the most recent past entry
// so values carry forward until explicitly changed.
// Legacy global format { activity: value } is still read correctly and migrated
// to per-day on the first write.

function _mostRecentLevels(parsed, dateKey) {
    if (parsed[dateKey]) return parsed[dateKey];
    const past = Object.keys(parsed).filter(k => _DATE_KEY_RX.test(k) && k < dateKey).sort();
    return past.length ? parsed[past[past.length - 1]] : {};
}

function getAllLevels(key) {
    try {
        const parsed = JSON.parse(Storage.getItem(key)) || {};
        if (_looksLikePerDay(parsed)) return _mostRecentLevels(parsed, getDateKey(viewDate));
        return parsed; // legacy global format
    } catch(e) { return {}; }
}
function getLevelsForDay(key) {
    return getAllLevels(key);
}
function setLevel(key, activity, value) {
    let fullData;
    try { fullData = JSON.parse(Storage.getItem(key)) || {}; }
    catch(e) { fullData = {}; }

    const today = getDateKey(viewDate);

    // Migrate legacy global format to per-day on first write
    if (Object.keys(fullData).length > 0 && !_looksLikePerDay(fullData)) {
        fullData = { [today]: { ...fullData } };
    }

    // Seed today's entry from the most recent past entry if not yet set today
    if (!fullData[today]) {
        const past = Object.keys(fullData).filter(k => _DATE_KEY_RX.test(k) && k < today).sort();
        fullData[today] = past.length ? { ...fullData[past[past.length - 1]] } : {};
    }

    if (value === 0) {
        delete fullData[today][activity];
    } else {
        fullData[today][activity] = value;
    }
    Storage.setItem(key, JSON.stringify(fullData));
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
        return !!(day.hydration || day.cryotherapy || day.creatine || day.nutrition != null || day.sleep != null);
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
    if (catName === 'Creativity') {
        const prefix = getDateKey(viewDate) + '__';
        const checks = getCreativityChecks();
        return Object.keys(checks).some(k => k.startsWith(prefix) && checks[k]);
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
function refreshChartAfterDataChange() {
    saveDayData();
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
        input.selectionStart = input.selectionEnd = input.value.length;

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


    // ── Bottom label spread ───────────────────────────────────────────────────
    // Indices 3 (Mindfulness) and 4 (Recovery) sit at the bottom of the shape.
    // Decrease this number to push them CLOSER together; increase to spread them APART.
    // The default for all other labels is maxValue + 1.5.
    const BOTTOM_LABEL_DISTANCE = maxValue - 3;
    // Increase to push the bottom two labels DOWN; decrease (or use negative) to move them UP.
    const BOTTOM_LABEL_Y_OFFSET = 75;

    categories.forEach((cat, i) => {
        const outer = getCoords(i, maxValue);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", centerX); line.setAttribute("y1", centerY);
        line.setAttribute("x2", outer.x); line.setAttribute("y2", outer.y);
        line.setAttribute("class", "grid-line");
        svg.appendChild(line);


        const labelDistance = (i === 3 || i === 4) ? BOTTOM_LABEL_DISTANCE : maxValue + 1.5;
        const labelPos = getCoords(i, labelDistance);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", labelPos.x);
        text.setAttribute("y", labelPos.y + ((i === 3 || i === 4) ? BOTTOM_LABEL_Y_OFFSET : 0));


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
        if (!cat.touched || percentage <= 2) labelText.style.display = 'none';

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

// ── Swipe left/right on the main view to change day ───────────────────────────
(function () {
    const COMMIT_THRESHOLD = 60;
    const DRAG_THRESHOLD   = 8;
    const MODAL_IDS = ['exerciseModal','spiritualModal','mindfulnessModal','recoveryModal','reflectionModal','mindsetModal','calendarModal','noteModal','avoidedModal','creativityModal'];

    const container = document.querySelector('.app-container');
    let startX = 0, startY = 0, tracking = false, dragging = false, capturedId = null;

    container.addEventListener('pointerdown', (e) => {
        if (tracking) return;
        if (MODAL_IDS.some(id => document.getElementById(id).style.display === 'flex')) return;
        if (e.target.closest('#sins-mixer')) return; // mixer has its own swipe
        startX = e.clientX; startY = e.clientY;
        tracking = true; dragging = false; capturedId = e.pointerId;
    });

    container.addEventListener('pointermove', (e) => {
        if (!tracking || e.pointerId !== capturedId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging) {
            if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            if (Math.abs(dy) > Math.abs(dx)) { tracking = false; return; } // vertical → scroll
            dragging = true;
            try { container.setPointerCapture(e.pointerId); } catch (_) {}
        }
        e.preventDefault();
    }, { passive: false });

    const endSwipe = (e) => {
        if (!tracking || e.pointerId !== capturedId) return;
        tracking = false; capturedId = null;
        if (!dragging) return;
        dragging = false;
        const dx = e.clientX - startX;
        if (Math.abs(dx) >= COMMIT_THRESHOLD) {
            viewDate.setDate(viewDate.getDate() + (dx < 0 ? 1 : -1));
            loadDayData();
        }
    };

    container.addEventListener('pointerup', endSwipe);
    container.addEventListener('pointercancel', endSwipe);
})();

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

    const savedData = Storage.getItem(STORAGE_KEY);
    const allData = savedData ? JSON.parse(savedData) : {};
    const realToday = new Date();
    const todayStr = `${realToday.getFullYear()}-${String(realToday.getMonth()+1).padStart(2,'0')}-${String(realToday.getDate()).padStart(2,'0')}`;

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

            const dayStr = `${year}-${String(month+1).padStart(2,'0')}-${String(dayNumber).padStart(2,'0')}`;
            const dayEntry = allData[dayStr];
            if (dayStr < todayStr && dayEntry) {
                const vitals = Array.isArray(dayEntry) ? dayEntry : (dayEntry.vitals || []);
                const score = vitals.reduce((sum, v) => sum + (v.value || 0), 0);
                const alpha = 0.08 + (score / 60) * 0.92;
                div.style.backgroundColor = `rgba(74, 222, 128, ${alpha.toFixed(2)})`;
            }

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
    if (cat.name === 'Creativity') { openCreativityModal(); return; }
    activeNoteIdx = index;
    noteTitle.textContent = cat.name.toUpperCase() + " NOTES";
    noteArea.value = cat.note || "";
    noteModal.style.display = 'flex';
    setTimeout(() => { noteArea.focus(); autoGrow(noteArea); }, 50);
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

        const label = document.createElement('span');
        label.className = 'sin-label';
        const displayName = (mode === 'virtues' && window.innerWidth <= 480 && activity.length > 5)
            ? activity.slice(0, 5) + '.' : activity;
        label.textContent = displayName;
        if (activity === 'Lust') {
            label.style.cursor = 'pointer';
            label.onclick = (e) => { e.stopPropagation(); toggleLustPopup(label); };
        }

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
            refreshChartAfterDataChange();
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
                refreshChartAfterDataChange();
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
        let pressStartX = 0, pressStartY = 0;
        row.addEventListener('contextmenu', e => e.preventDefault());
        row.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.mindset-check')) return;
            if (panel.classList.contains('open')) return;
            renameTriggered = false;
            pressStartX = e.clientX; pressStartY = e.clientY;
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
        row.addEventListener('pointermove', (e) => {
            if (!pressTimer) return;
            if (Math.abs(e.clientX - pressStartX) > 8 || Math.abs(e.clientY - pressStartY) > 8) {
                clearTimeout(pressTimer); pressTimer = null;
            }
        });
        row.addEventListener('pointerup', () => { clearTimeout(pressTimer); pressTimer = null; });
        row.addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressTimer = null; });

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

// ─── Creativity list ──────────────────────────────────────────────────────────
function getCreativityLibrary() {
    const raw = Storage.getItem('creativity_library');
    return raw ? JSON.parse(raw) : [];
}
function saveCreativityLibrary(lib) {
    Storage.setItem('creativity_library', JSON.stringify(lib));
}
function getCreativityChecks() {
    const raw = Storage.getItem('creativity_checks');
    return raw ? JSON.parse(raw) : {};
}
function saveCreativityChecks(checks) {
    Storage.setItem('creativity_checks', JSON.stringify(checks));
}
function getCreativityNotes() {
    const raw = Storage.getItem('creativity_notes');
    return raw ? JSON.parse(raw) : {};
}
function saveCreativityNotes(notes) {
    Storage.setItem('creativity_notes', JSON.stringify(notes));
}
function getCreativityNoteKey(item) {
    return getDateKey(viewDate) + '__' + item;
}
function isCreativityChecked(item) {
    return !!getCreativityChecks()[getCreativityNoteKey(item)];
}
function setCreativityChecked(item, val) {
    const checks = getCreativityChecks();
    const key = getCreativityNoteKey(item);
    if (val) checks[key] = true; else delete checks[key];
    saveCreativityChecks(checks);
}
function creativityHasDataToday() {
    const prefix = getDateKey(viewDate) + '__';
    const notes = getCreativityNotes();
    if (Object.keys(notes).some(k => k.startsWith(prefix) && notes[k])) return true;
    const checks = getCreativityChecks();
    return Object.keys(checks).some(k => k.startsWith(prefix) && checks[k]);
}
function renameCreativityItem(oldName, newName) {
    if (oldName === newName) return;
    const lib = getCreativityLibrary();
    const idx = lib.indexOf(oldName);
    if (idx >= 0) { lib[idx] = newName; saveCreativityLibrary(lib); }
    const oldSuffix = '__' + oldName;
    const newSuffix = '__' + newName;
    const notes = getCreativityNotes();
    Object.keys(notes).forEach(k => {
        if (k.endsWith(oldSuffix)) { notes[k.slice(0, -oldSuffix.length) + newSuffix] = notes[k]; delete notes[k]; }
    });
    saveCreativityNotes(notes);
    const checks = getCreativityChecks();
    Object.keys(checks).forEach(k => {
        if (k.endsWith(oldSuffix)) { checks[k.slice(0, -oldSuffix.length) + newSuffix] = checks[k]; delete checks[k]; }
    });
    saveCreativityChecks(checks);
}

function renderCreativityList() {
    const list = document.getElementById('creativity-list');
    if (!list) return;
    list.innerHTML = '';
    const items = getCreativityLibrary();

    if (items.length === 0) {
        list.innerHTML = '<p class="empty-state">Nothing yet. Add one below.</p>';
        return;
    }

    items.forEach(item => {
        const noteKey = getCreativityNoteKey(item);
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
            const on = isCreativityChecked(item);
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
                const lib = getCreativityLibrary().filter(b => b !== item);
                saveCreativityLibrary(lib);
                const keyFrag = '__' + item;
                const allNotes = getCreativityNotes();
                Object.keys(allNotes).forEach(k => { if (k.endsWith(keyFrag)) delete allNotes[k]; });
                saveCreativityNotes(allNotes);
                const allChecks = getCreativityChecks();
                Object.keys(allChecks).forEach(k => { if (k.endsWith(keyFrag)) delete allChecks[k]; });
                saveCreativityChecks(allChecks);
                closeOpenPanel(list, () => { renderCreativityList(); refreshChartAfterDataChange(); });
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
        ta.value = getCreativityNotes()[noteKey] || '';

        const saveEntry = () => {
            const allNotes = getCreativityNotes();
            const value = ta.value.trim();
            if (value) allNotes[noteKey] = value; else delete allNotes[noteKey];
            saveCreativityNotes(allNotes);
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

        let pressTimer = null;
        let renameTriggered = false;
        let pressStartX = 0, pressStartY = 0;
        row.addEventListener('contextmenu', e => e.preventDefault());
        row.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.mindset-check')) return;
            if (panel.classList.contains('open')) return;
            renameTriggered = false;
            pressStartX = e.clientX; pressStartY = e.clientY;
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
                        renameCreativityItem(item, newName);
                        renderCreativityList();
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
        row.addEventListener('pointermove', (e) => {
            if (!pressTimer) return;
            if (Math.abs(e.clientX - pressStartX) > 8 || Math.abs(e.clientY - pressStartY) > 8) {
                clearTimeout(pressTimer); pressTimer = null;
            }
        });
        row.addEventListener('pointerup', () => { clearTimeout(pressTimer); pressTimer = null; });
        row.addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressTimer = null; });

        const openNotesPanel = () => {
            if (panel.classList.contains('open')) { setTimeout(() => ta.focus(), 50); return; }
            list.querySelectorAll('.entry-wrapper').forEach(w => { if (w !== wrapper) collapseEntryWrapper(w); });
            panel.classList.add('open');
            row.classList.add('open');
            setTimeout(() => ta.focus(), 400);
        };

        check.onclick = (e) => {
            e.stopPropagation();
            setCreativityChecked(item, !isCreativityChecked(item));
            syncCheck();
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

function openCreativityModal() {
    renderCreativityList();
    document.getElementById('creativityModal').style.display = 'flex';
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
    setTimeout(() => { const ta = document.getElementById('exSimpleNotes'); ta.focus(); autoGrow(ta); }, 50);
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
                .map(s => `${s.weight||'?'}lbs × ${s.reps||'?'}`)
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

        const handle = document.createElement('span');
        handle.className = 'ex-drag-handle';
        handle.textContent = '⠿';

        row.appendChild(handle);
        row.appendChild(name);
        row.appendChild(meta);
        row.appendChild(del);

        row.onclick = (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.ex-drag-handle')) return;
            openSetsScreen(ex);
        };

        attachExerciseDragHandlers(handle, row);

        list.appendChild(row);
    });
}

// ─── Exercise drag-to-reorder ────────────────────────────────────────
// Grab the ⠿ handle on the left of each row to reorder. touch-action:none
// on the handle means the browser never competes for the gesture — drag
// starts as soon as the finger moves > 5px, no long-press timer needed.
// Tap anywhere else on the row opens the sets screen (via row.onclick).
let _exDrag = null; // null when idle; otherwise holds drag state

function attachExerciseDragHandlers(handle, row) {
    let startX = 0, startY = 0;
    let activePointerId = null;
    let dragStarted = false;

    const onPointerDown = (e) => {
        if (e.button === 2) return;
        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        dragStarted = false;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
    };

    const beginDrag = () => {
        const list = document.getElementById('exercise-list');
        const rect = row.getBoundingClientRect();
        const otherRows = Array.from(list.querySelectorAll('.exercise-row')).filter(r => r !== row);
        _exDrag = {
            row, list, otherRows,
            rowHeight: rect.height,
            grabOffsetY: startY - rect.top,
            currentBeforeRow: null,
        };
        row.classList.add('dragging');
        try { row.setPointerCapture(activePointerId); } catch (_) {}
        if (navigator.vibrate) navigator.vibrate(15);
    };

    const onPointerMove = (e) => {
        if (e.pointerId !== activePointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!dragStarted) {
            if (Math.sqrt(dx * dx + dy * dy) < 5) return;
            dragStarted = true;
            beginDrag();
        }

        if (!_exDrag) return;
        e.preventDefault();

        const pointerY = e.clientY;
        const list = _exDrag.list;

        const anchorToPointer = () => {
            _exDrag.row.style.transform = '';
            const naturalTop = _exDrag.row.getBoundingClientRect().top;
            const desiredTop = pointerY - _exDrag.grabOffsetY;
            _exDrag.row.style.transform = `translateY(${desiredTop - naturalTop}px)`;
        };

        anchorToPointer();

        let insertBefore = null;
        for (const other of _exDrag.otherRows) {
            const r = other.getBoundingClientRect();
            if (pointerY < r.top + r.height / 2) { insertBefore = other; break; }
        }

        if (insertBefore !== _exDrag.currentBeforeRow) {
            const movedRows = _exDrag.otherRows;
            movedRows.forEach(r => { r.style.transition = 'none'; r.style.transform = ''; });
            const firstRects = movedRows.map(r => r.getBoundingClientRect());

            if (insertBefore) {
                list.insertBefore(_exDrag.row, insertBefore);
            } else {
                list.appendChild(_exDrag.row);
            }
            _exDrag.currentBeforeRow = insertBefore;

            anchorToPointer();

            movedRows.forEach((r, i) => {
                const delta = firstRects[i].top - r.getBoundingClientRect().top;
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
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);

        if (_exDrag) {
            const list = _exDrag.list;
            const finalOrder = Array.from(list.querySelectorAll('.exercise-row'))
                .map(r => r.querySelector('.exercise-row-name').textContent);
            _exDrag.row.classList.remove('dragging');
            _exDrag.row.style.transform = '';
            _exDrag.otherRows.forEach(r => { r.style.transition = ''; r.style.transform = ''; });
            _exDrag = null;
            persistExerciseOrder(finalOrder);
        }

        activePointerId = null;
        dragStarted = false;
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('click', e => e.stopPropagation());
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
        weightInput.placeholder = 'lbs';
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
            document.getElementById('ex-exercise-title').textContent = newName.toUpperCase();
            renderExerciseList();
        }
    );

    const notes = getExerciseNotes();
    const rawNote = notes[getExerciseNoteKey(activeMuscle, exercise)] || '';
    const lines = rawNote
        ? rawNote.split('\n').map(l => l && !l.startsWith('• ') ? '• ' + l : l)
        : ['• '];
    const el = document.getElementById('exNotesInput');
    el.innerHTML = '';
    lines.forEach(line => {
        const div = document.createElement('div');
        div.textContent = line;
        el.appendChild(div);
    });
    showExScreen('ex-screen-ex-notes');
    setTimeout(() => {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
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
    const value = document.getElementById('exNotesInput').innerText.trim();
    notes[getExerciseNoteKey(activeMuscle, activeExercise)] =
        /^[•\s]*$/.test(value) ? '' : value;
    saveExerciseNotes(notes);
}

try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (_) {}

document.getElementById('exNotesInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.execCommand('insertParagraph', false, null);
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    let lineDiv = range.startContainer;
    if (lineDiv.nodeType === Node.TEXT_NODE) lineDiv = lineDiv.parentNode;
    const container = document.getElementById('exNotesInput');
    while (lineDiv && lineDiv.parentNode !== container) lineDiv = lineDiv.parentNode;
    if (lineDiv && !lineDiv.textContent.startsWith('• ')) {
        document.execCommand('insertText', false, '• ');
    }
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

document.getElementById('closeCreativityModal').onclick = () => {
    document.getElementById('creativityModal').style.display = 'none';
};
document.getElementById('creativityAddBtn').onclick = () => {
    const input = document.getElementById('creativityInput');
    const name = input.value.trim();
    if (!name) return;
    const lib = getCreativityLibrary();
    if (!lib.map(b => b.toLowerCase()).includes(name.toLowerCase())) {
        lib.push(name);
        saveCreativityLibrary(lib);
    }
    input.value = '';
    const list = document.getElementById('creativity-list');
    closeOpenPanel(list, () => {
        renderCreativityList();
        const wrappers = list.querySelectorAll('.entry-wrapper');
        const newest = wrappers[wrappers.length - 1];
        if (newest) {
            newest.classList.add('entry-collapsing');
            requestAnimationFrame(() => requestAnimationFrame(() => newest.classList.remove('entry-collapsing')));
        }
    });
};
document.getElementById('creativityInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('creativityAddBtn').click();
});

document.getElementById('closeExerciseModal3').onclick = () => {
    saveSets();
    renderExerciseList();
    showExScreen('ex-screen-exercises');
};


document.getElementById('closeExerciseModal').onclick = () => {
    document.getElementById('exerciseModal').style.display = 'none';
};


window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ['exerciseModal','spiritualModal','mindfulnessModal','recoveryModal','reflectionModal','mindsetModal','creativityModal','musicModal']
            .forEach(id => document.getElementById(id).style.display = 'none');
    }
});


function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

['noteArea', 'exSimpleNotes', 'msBookNotes', 'avoidedNotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => autoGrow(el));
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
            ta.addEventListener('input', () => autoGrow(ta));

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
            let pressStartX = 0, pressStartY = 0;
            row.addEventListener('contextmenu', e => e.preventDefault());
            row.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.exercise-delete-btn')) return;
                if (panel.classList.contains('open')) return;
                renameTriggered = false;
                pressStartX = e.clientX; pressStartY = e.clientY;
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
            row.addEventListener('pointermove', (e) => {
                if (!pressTimer) return;
                if (Math.abs(e.clientX - pressStartX) > 8 || Math.abs(e.clientY - pressStartY) > 8) {
                    clearTimeout(pressTimer); pressTimer = null;
                }
            });
            row.addEventListener('pointerup', () => { clearTimeout(pressTimer); pressTimer = null; });
            row.addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressTimer = null; });

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
                setTimeout(() => { ta.focus(); autoGrow(ta); }, 400);
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
    setTimeout(() => {
        const notesEl = document.getElementById(p + 'NotesInput');
        notesEl.focus();
        autoGrow(notesEl);
    }, 50);
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

    const notesInput = document.getElementById(p + 'NotesInput');
    if (notesInput) notesInput.addEventListener('input', () => autoGrow(notesInput));

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


// ─── Recovery Slider Buttons ──────────────────────────────────────────────────
const RECOVERY_KEY = 'recovery_data';

function formatSleepVal(val) {
    const h = Math.floor(val);
    const m = Math.round((val - h) * 60);
    return m === 0 ? `${h} hrs` : `${h}:${String(m).padStart(2, '0')} hrs`;
}

function getRecoveryData() {
    const raw = Storage.getItem(RECOVERY_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] || {};
}
function saveRecoveryData(data) {
    const raw = Storage.getItem(RECOVERY_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const hasAny = data.nutrition != null || data.hydration || data.cryotherapy || data.creatine || data.sleep != null;
    if (hasAny) {
        all[getDateKey(viewDate)] = data;
    } else {
        delete all[getDateKey(viewDate)];
    }
    Storage.setItem(RECOVERY_KEY, JSON.stringify(all));
}

const RC_SLIDERS = [
    {
        id: 'rc-slide-hydration', key: 'hydration',
        min: 0, max: 15, step: 1,
        fmt: v => v === 0 ? '—' : v + (v === 1 ? ' cup' : ' cups'),
        fromStorage: d => d.hydration != null ? (typeof d.hydration === 'boolean' ? 5 : +d.hydration) : 0,
    },
    {
        id: 'rc-slide-cryo', key: 'cryotherapy',
        min: 0, max: 1, step: 1,
        fmt: () => '',
        fromStorage: d => d.cryotherapy ? 1 : 0,
        clickOnly: true,
    },
    {
        id: 'rc-slide-creatine', key: 'creatine',
        min: 0, max: 1, step: 1,
        fmt: () => '',
        fromStorage: d => d.creatine ? 1 : 0,
        clickOnly: true,
    },
    {
        id: 'rc-slide-calories', key: 'nutrition',
        min: 0, max: 4000, step: 100,
        fmt: v => v === 0 ? '—' : v + ' cal',
        fromStorage: d => d.nutrition != null ? d.nutrition : 0,
        clickOnly: true,
        onClick: () => openCalorieScreen(),
    },
    {
        id: 'rc-slide-sleep', key: 'sleep',
        min: 7, max: 9, step: 0.25,
        fmt: v => v === 0 ? '—' : formatSleepVal(v),
        fromStorage: d => d.sleep != null ? d.sleep : 0,
    },
];

const _rcValues = {};

function _rcPersist() {
    const data = getRecoveryData();
    RC_SLIDERS.forEach(cfg => {
        const v = _rcValues[cfg.key];
        if (v === undefined) return;
        if (v === 0) { delete data[cfg.key]; } else { data[cfg.key] = v; }
    });
    saveRecoveryData(data);
    refreshChartAfterDataChange();
}

function _rcSetUI(cfg, v) {
    const el = document.getElementById(cfg.id);
    const fill = el.querySelector('.rc-btn-fill');
    const valEl = el.querySelector('.rc-btn-value');
    const pct = v === 0 ? 0 : Math.max(0, ((v - cfg.min) / (cfg.max - cfg.min)) * 100);
    fill.style.width = pct + '%';
    valEl.textContent = cfg.fmt(v);
    el.dataset.empty = v === 0 ? 'true' : 'false';
    el.classList.toggle('has-data', v !== 0);
}

function refreshRcUI() {
    const data = getRecoveryData();
    RC_SLIDERS.forEach(cfg => {
        const v = cfg.fromStorage(data);
        _rcValues[cfg.key] = v;
        _rcSetUI(cfg, v);
    });
}

function openRecoveryModal() {
    refreshRcUI();
    // Sync calories from food log (food log is the source of truth)
    const { cal } = calcFoodTotals();
    _rcValues['nutrition'] = cal;
    const calCfg = RC_SLIDERS.find(c => c.key === 'nutrition');
    if (calCfg) _rcSetUI(calCfg, cal);
    document.getElementById('recoveryModal').style.display = 'flex';
}

(function initRcSliders() {
    RC_SLIDERS.forEach(cfg => {
        const el = document.getElementById(cfg.id);

        if (cfg.clickOnly) {
            el.addEventListener('click', () => {
                if (cfg.onClick) { cfg.onClick(); return; }
                const cur = _rcValues[cfg.key] || 0;
                _rcValues[cfg.key] = cur ? 0 : 1;
                _rcSetUI(cfg, _rcValues[cfg.key]);
                _rcPersist();
            });
            return;
        }

        let dragging = false;

        function fromX(clientX) {
            const r = el.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
            const raw = cfg.min + ratio * (cfg.max - cfg.min);
            const stepped = Math.round(raw / cfg.step) * cfg.step;
            return Math.max(cfg.min, Math.min(cfg.max, stepped));
        }

        el.addEventListener('pointerdown', e => {
            dragging = true;
            el.setPointerCapture(e.pointerId);
            el.classList.add('dragging');
            const v = fromX(e.clientX);
            _rcValues[cfg.key] = v;
            _rcSetUI(cfg, v);
        });
        el.addEventListener('pointermove', e => {
            if (!dragging) return;
            const v = fromX(e.clientX);
            _rcValues[cfg.key] = v;
            _rcSetUI(cfg, v);
        });
        el.addEventListener('pointerup', () => {
            if (!dragging) return;
            dragging = false;
            el.classList.remove('dragging');
            _rcPersist();
        });
        el.addEventListener('pointercancel', () => {
            dragging = false;
            el.classList.remove('dragging');
        });
    });
})();

document.getElementById('closeRecoveryModal').onclick = () => {
    document.getElementById('recoveryModal').style.display = 'none';
};


// ─── Calorie / Food Tracker ───────────────────────────────────────────────────
const FOOD_LIBRARY_KEY = 'food_library_v1';
const FOOD_LOG_KEY     = 'food_log_v1';

// ─── Food drag-to-reorder (pointer-based FLIP, same system as exercises) ──────
function attachFoodDragHandlers(handle, row, listId) {
    let startX = 0, startY = 0, activePointerId = null, dragStarted = false, state = null;

    handle.addEventListener('pointerdown', e => {
        if (e.button === 2) return;
        activePointerId = e.pointerId;
        startX = e.clientX; startY = e.clientY;
        dragStarted = false;
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup',   onUp);
        document.addEventListener('pointercancel', onUp);
    });
    handle.addEventListener('click', e => e.stopPropagation());

    const beginDrag = () => {
        const list = document.getElementById(listId);
        const rect = row.getBoundingClientRect();
        const others = Array.from(list.querySelectorAll('.rc-food-row')).filter(r => r !== row);
        state = { list, others, grabOffsetY: startY - rect.top, currentBefore: null };
        row.classList.add('rc-dragging');
        try { row.setPointerCapture(activePointerId); } catch (_) {}
    };

    const onMove = e => {
        if (e.pointerId !== activePointerId) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!dragStarted) {
            if (Math.sqrt(dx*dx + dy*dy) < 5) return;
            dragStarted = true; beginDrag();
        }
        if (!state) return;
        e.preventDefault();

        const py = e.clientY;
        const anchor = () => {
            row.style.transform = '';
            const nat = row.getBoundingClientRect().top;
            row.style.transform = `translateY(${py - state.grabOffsetY - nat}px)`;
        };
        anchor();

        let before = null;
        for (const r of state.others) {
            const b = r.getBoundingClientRect();
            if (py < b.top + b.height / 2) { before = r; break; }
        }
        if (before === state.currentBefore) return;

        state.others.forEach(r => { r.style.transition = 'none'; r.style.transform = ''; });
        const rects = state.others.map(r => r.getBoundingClientRect());
        if (before) state.list.insertBefore(row, before); else state.list.appendChild(row);
        state.currentBefore = before;
        anchor();
        state.others.forEach((r, i) => {
            const delta = rects[i].top - r.getBoundingClientRect().top;
            if (!delta) return;
            r.style.transition = 'none';
            r.style.transform = `translateY(${delta}px)`;
            requestAnimationFrame(() => {
                r.style.transition = 'transform 180ms cubic-bezier(0.2,0,0,1)';
                r.style.transform = '';
            });
        });
    };

    const onUp = e => {
        if (e.pointerId !== activePointerId) return;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup',   onUp);
        document.removeEventListener('pointercancel', onUp);
        if (state) {
            const list = state.list;
            const newIds = Array.from(list.querySelectorAll('.rc-food-row'))
                .map(r => r.dataset.foodId).filter(Boolean);
            row.classList.remove('rc-dragging');
            row.style.transform = '';
            state.others.forEach(r => { r.style.transition = ''; r.style.transform = ''; });
            state = null;
            const foods = getFoodLibrary();
            const reordered = newIds.map(id => foods.find(f => f.id === id)).filter(Boolean);
            foods.forEach(f => { if (!reordered.find(x => x.id === f.id)) reordered.push(f); });
            saveFoodLibrary(reordered);
        }
        activePointerId = null; dragStarted = false;
    };
}

const FOOD_CATS      = ['B', 'S', 'L', 'D'];
const FOOD_CAT_NAMES = { B: 'BREAKFAST', S: 'SNACKS', L: 'LUNCH', D: 'DINNER' };
const FOOD_CAT_LABELS = { B: 'BREAKFAST', S: 'SNACK', L: 'LUNCH', D: 'DINNER' };

// Single shared dropdown lives on body — escapes all overflow/clip contexts
const _sharedCatDropdown = (() => {
    const el = document.createElement('div');
    el.className = 'rc-cat-picker';
    document.body.appendChild(el);
    return el;
})();
let _sharedCatBadge = null;

function makeCatPicker(initialCat, onSelect) {
    const wrap = document.createElement('div');
    wrap.className = 'rc-cat-picker-wrap';

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'rc-food-cat-badge';
    badge.textContent = initialCat || '?';

    badge.addEventListener('click', e => {
        e.stopPropagation();
        if (_sharedCatDropdown.style.display === 'flex' && _sharedCatBadge === badge) {
            _sharedCatDropdown.style.display = 'none';
            _sharedCatBadge = null;
            return;
        }
        _sharedCatBadge = badge;

        _sharedCatDropdown.innerHTML = '';
        FOOD_CATS.forEach(cat => {
            const opt = document.createElement('button');
            opt.type = 'button';
            opt.className = 'rc-cat-picker-opt' + (cat === badge.textContent ? ' rc-cat-picker-opt--active' : '');
            opt.textContent = FOOD_CAT_LABELS[cat];
            opt.addEventListener('click', ev => {
                ev.stopPropagation();
                badge.textContent = cat;
                _sharedCatDropdown.style.display = 'none';
                _sharedCatBadge = null;
                if (onSelect) onSelect(cat);
            });
            _sharedCatDropdown.appendChild(opt);
        });

        const rect = badge.getBoundingClientRect();
        _sharedCatDropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        _sharedCatDropdown.style.top    = 'auto';
        if (wrap.classList.contains('rc-cat-picker-wrap--right')) {
            _sharedCatDropdown.style.right = (window.innerWidth - rect.right) + 'px';
            _sharedCatDropdown.style.left  = 'auto';
        } else {
            _sharedCatDropdown.style.left  = rect.left + 'px';
            _sharedCatDropdown.style.right = 'auto';
        }
        _sharedCatDropdown.style.display = 'flex';

        const close = (ev) => {
            if (ev.target !== badge && !_sharedCatDropdown.contains(ev.target)) {
                _sharedCatDropdown.style.display = 'none';
                _sharedCatBadge = null;
                document.removeEventListener('click', close, true);
            }
        };
        setTimeout(() => document.addEventListener('click', close, true), 0);
    });

    wrap.appendChild(badge);
    wrap.getCat = () => badge.textContent === '?' ? 'B' : badge.textContent;
    return wrap;
}

function getFoodLibrary() {
    const raw = Storage.getItem(FOOD_LIBRARY_KEY);
    return raw ? JSON.parse(raw) : [];
}
function saveFoodLibrary(foods) {
    Storage.setItem(FOOD_LIBRARY_KEY, JSON.stringify(foods));
}
function getTodayFoodLog() {
    const raw = Storage.getItem(FOOD_LOG_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const day = all[getDateKey(viewDate)];
    if (!day) return {};
    // migrate old array format → {id: portions}
    if (Array.isArray(day)) {
        const obj = {};
        day.forEach(id => { obj[id] = 1; });
        return obj;
    }
    return day;
}
function setTodayFoodLog(log) {
    const raw = Storage.getItem(FOOD_LOG_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const hasAny = Object.values(log).some(v => v > 0);
    if (hasAny) { all[getDateKey(viewDate)] = log; }
    else { delete all[getDateKey(viewDate)]; }
    Storage.setItem(FOOD_LOG_KEY, JSON.stringify(all));
}
function calcFoodTotals() {
    const foods = getFoodLibrary();
    const log = getTodayFoodLog();
    let cal = 0, prot = 0;
    Object.entries(log).forEach(([id, portions]) => {
        const f = foods.find(x => x.id === id);
        if (f && portions > 0) { cal += (f.calories || 0) * portions; prot += (f.protein || 0) * portions; }
    });
    return { cal, prot };
}

function syncCaloriesToSlider() {
    const { cal, prot } = calcFoodTotals();
    const calEl  = document.getElementById('rc-cal-display');
    const protEl = document.getElementById('rc-prot-display');
    if (calEl)  calEl.textContent  = cal;
    if (protEl) protEl.textContent = prot;

    _rcValues['nutrition'] = cal;
    const cfg = RC_SLIDERS.find(c => c.key === 'nutrition');
    if (cfg) _rcSetUI(cfg, cal);

    const data = getRecoveryData();
    if (cal  > 0) { data.nutrition = cal;  } else { delete data.nutrition; }
    if (prot > 0) { data.protein   = prot; } else { delete data.protein;   }
    saveRecoveryData(data);
    refreshChartAfterDataChange();
}

function showRcScreen(id) {
    ['rc-screen-type', 'rc-screen-calories', 'rc-screen-add-food', 'rc-screen-past-foods', 'rc-screen-cat-foods']
        .forEach(s => { document.getElementById(s).style.display = s === id ? 'block' : 'none'; });
}

function openCalorieScreen() {
    renderFoodList();
    showRcScreen('rc-screen-calories');
}

function renderFoodList() {
    const list  = document.getElementById('rc-food-list');
    list.innerHTML = '';
    const foods = getFoodLibrary();
    const log   = getTodayFoodLog();
    const eaten = foods.filter(f => (log[f.id] || 0) > 0);

    if (eaten.length === 0) {
        list.innerHTML = '<p class="empty-state">No foods logged today.</p>';
    } else {
        eaten.forEach(food => list.appendChild(buildFoodRow(food, log)));
    }
    syncCaloriesToSlider();
}

function fmtPortions(n) {
    return '×' + (n % 1 === 0 ? String(n) : n.toFixed(1));
}

function buildFoodRow(food, log) {
    const portions   = log[food.id] || 0;
    const isSelected = portions > 0;

    const row = document.createElement('div');
    row.className = 'rc-food-row' + (isSelected ? ' rc-food-selected' : '');
    row.dataset.foodId = food.id;

    const handle = document.createElement('span');
    handle.className = 'rc-drag-handle';
    handle.textContent = '⠿';
    attachFoodDragHandlers(handle, row, 'rc-food-list');

    const info = document.createElement('div');
    info.className = 'rc-food-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'rc-food-name-label';
    nameEl.textContent = food.name;

    const macrosEl = document.createElement('span');
    macrosEl.className = 'rc-food-macros';
    macrosEl.textContent = `${food.calories} cal · ${food.protein}g`;

    info.appendChild(nameEl);
    info.appendChild(macrosEl);

    row.appendChild(handle);
    row.appendChild(info);

    // Portion control — only in DOM when selected
    if (isSelected) {
        const portionCtrl = document.createElement('div');
        portionCtrl.className = 'rc-food-portions';

        const minusBtn = document.createElement('button');
        minusBtn.className = 'rc-portion-btn';
        minusBtn.textContent = '−';

        const countEl = document.createElement('span');
        countEl.className = 'rc-portion-count';
        countEl.textContent = fmtPortions(portions);

        const plusBtn = document.createElement('button');
        plusBtn.className = 'rc-portion-btn';
        plusBtn.textContent = '+';

        portionCtrl.appendChild(minusBtn);
        portionCtrl.appendChild(countEl);
        portionCtrl.appendChild(plusBtn);
        row.appendChild(portionCtrl);

        let closeTimer = null;
        const scheduleClose = () => {
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => portionCtrl.classList.remove('expanded'), 1000);
        };

        // Click badge to toggle expanded
        portionCtrl.addEventListener('click', e => {
            e.stopPropagation();
            portionCtrl.classList.toggle('expanded');
            if (portionCtrl.classList.contains('expanded')) scheduleClose();
            else clearTimeout(closeTimer);
        });

        const applyPortionDelta = (delta) => {
            const log = getTodayFoodLog();
            const cur = log[food.id] || 0.5;
            const next = Math.round((cur + delta) * 10) / 10;
            if (next <= 0) {
                delete log[food.id];
                setTodayFoodLog(log);
                renderFoodList(); // full re-render to remove selected state
                return;
            }
            log[food.id] = next;
            setTodayFoodLog(log);
            countEl.textContent = fmtPortions(next); // update in place
            syncCaloriesToSlider();
            scheduleClose(); // reset 1-second timer
        };

        minusBtn.addEventListener('click', e => { e.stopPropagation(); applyPortionDelta(-0.5); });
        plusBtn.addEventListener('click',  e => { e.stopPropagation(); applyPortionDelta(+0.5); });
    }

    row.addEventListener('click', e => {
        if (e.target.closest('.rc-food-portions') || e.target.closest('.rc-drag-handle')) return;
        const log = getTodayFoodLog();
        if (log[food.id]) {
            // Deselect — keep row visible so it can be re-selected; disappears on next open
            delete log[food.id];
            setTodayFoodLog(log);
            row.classList.remove('rc-food-selected');
            const portionCtrl = row.querySelector('.rc-food-portions');
            if (portionCtrl) portionCtrl.style.display = 'none';
            syncCaloriesToSlider();
        } else {
            // Re-select — full re-render to restore portion control
            log[food.id] = 1;
            setTodayFoodLog(log);
            renderFoodList();
        }
    });

    return row;
}

function openFoodEditInRow(food, row, onDone) {
    row.innerHTML = '';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'ex-input rc-food-name-input';
    nameInput.value = food.name;
    nameInput.placeholder = 'Name';

    const calInput = document.createElement('input');
    calInput.type = 'number';
    calInput.className = 'ex-input rc-food-num-input';
    calInput.value = food.calories || '';
    calInput.placeholder = 'cal';

    const protInput = document.createElement('input');
    protInput.type = 'number';
    protInput.className = 'ex-input rc-food-num-input';
    protInput.value = food.protein || '';
    protInput.placeholder = 'g';

    const saveBtn   = document.createElement('button');
    saveBtn.className = 'ex-add-btn';
    saveBtn.textContent = '✓';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'exercise-delete-btn';
    cancelBtn.textContent = '×';

    const catPicker = makeCatPicker(food.category || 'B');

    const editRow = document.createElement('div');
    editRow.className = 'rc-food-edit-row';
    editRow.addEventListener('click', e => e.stopPropagation());
    editRow.appendChild(catPicker);
    editRow.appendChild(nameInput);
    editRow.appendChild(calInput);
    editRow.appendChild(protInput);
    const editBtnGroup = document.createElement('div');
    editBtnGroup.className = 'rc-food-actions';
    editBtnGroup.appendChild(saveBtn);
    editBtnGroup.appendChild(cancelBtn);
    editRow.appendChild(editBtnGroup);
    row.appendChild(editRow);
    nameInput.focus();

    const save = () => {
        const newName = nameInput.value.trim();
        if (!newName) return;
        const foods = getFoodLibrary();
        const f = foods.find(x => x.id === food.id);
        if (f) {
            f.name     = newName;
            f.calories = parseInt(calInput.value)  || 0;
            f.protein  = parseInt(protInput.value) || 0;
            f.category = catPicker.getCat();
        }
        saveFoodLibrary(foods);
        (onDone || renderFoodList)();
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', () => (onDone || renderFoodList)());
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); calInput.focus(); } });
    calInput.addEventListener('keydown',  e => { if (e.key === 'Enter') { e.preventDefault(); protInput.focus(); } });
    protInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
}

document.getElementById('rcAddFoodBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('rcFoodName');
    const calInput  = document.getElementById('rcFoodCal');
    const protInput = document.getElementById('rcFoodProt');
    const pickerWrap = document.querySelector('#rcNewFoodCat .rc-cat-picker-wrap');
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const foods = getFoodLibrary();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    foods.push({ id, name, calories: parseInt(calInput.value) || 0, protein: parseInt(protInput.value) || 0, category: pickerWrap ? pickerWrap.getCat() : 'B' });
    saveFoodLibrary(foods);
    const log = getTodayFoodLog();
    log[id] = 1;
    setTodayFoodLog(log);
    nameInput.value = '';
    calInput.value  = '';
    protInput.value = '';
    showRcScreen('rc-screen-calories');
    renderFoodList();
});

document.getElementById('rcFoodName').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('rcFoodCal').focus(); });
document.getElementById('rcFoodCal').addEventListener('keydown',  e => { if (e.key === 'Enter') document.getElementById('rcFoodProt').focus(); });
document.getElementById('rcFoodProt').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('rcAddFoodBtn').click(); });

document.getElementById('rcOpenAddFoodBtn').addEventListener('click', () => {
    const container = document.getElementById('rcNewFoodCat');
    container.innerHTML = '';
    const p = makeCatPicker(null);
    p.classList.add('rc-cat-picker-wrap--right');
    p.querySelector('.rc-food-cat-badge').classList.add('rc-food-cat-badge--input');
    container.appendChild(p);
    showRcScreen('rc-screen-add-food');
    document.getElementById('rcFoodName').focus();
});
document.getElementById('rcAddFoodBack').addEventListener('click', () => { showRcScreen('rc-screen-calories'); });

document.getElementById('rcViewPastBtn').addEventListener('click', () => { showRcScreen('rc-screen-past-foods'); });
document.getElementById('rcPastFoodsBack').addEventListener('click', () => { showRcScreen('rc-screen-calories'); });

document.getElementById('rc-category-grid').addEventListener('click', e => {
    const btn = e.target.closest('[data-cat]');
    if (btn) openCatFoodScreen(btn.dataset.cat);
});

let _activeCat = 'B';

function openCatFoodScreen(cat) {
    _activeCat = cat;
    document.getElementById('rc-cat-title').textContent = FOOD_CAT_NAMES[cat] || cat;
    const list = document.getElementById('rc-cat-food-list');
    list.innerHTML = '';
    const foods = getFoodLibrary().filter(f => (f.category || 'B') === cat);
    if (foods.length === 0) {
        list.innerHTML = '<p class="empty-state">No foods in this category yet.</p>';
    } else {
        foods.forEach(food => {
            const log = getTodayFoodLog();
            const row = document.createElement('div');
            row.className = 'rc-food-row' + (log[food.id] ? ' rc-food-selected' : '');
            row.dataset.foodId = food.id;

            const handle = document.createElement('span');
            handle.className = 'rc-drag-handle';
            handle.textContent = '⠿';
            attachFoodDragHandlers(handle, row, 'rc-cat-food-list');

            const dot = makeCatPicker(food.category || 'B', (newCat) => {
                const foods = getFoodLibrary();
                const f = foods.find(x => x.id === food.id);
                if (f) { f.category = newCat; saveFoodLibrary(foods); }
                openCatFoodScreen(_activeCat);
            });
            dot.addEventListener('click', e => e.stopPropagation());

            const info = document.createElement('div');
            info.className = 'rc-food-info';
            const nameEl = document.createElement('span');
            nameEl.className = 'rc-food-name-label';
            nameEl.textContent = food.name;
            const macrosEl = document.createElement('span');
            macrosEl.className = 'rc-food-macros';
            macrosEl.textContent = `${food.calories} cal · ${food.protein}g`;
            info.appendChild(nameEl);
            info.appendChild(macrosEl);

            const editBtn = document.createElement('button');
            editBtn.className = 'rc-food-edit-btn';
            editBtn.innerHTML = '&#9998;';

            const delBtn = document.createElement('button');
            delBtn.className = 'exercise-delete-btn';
            delBtn.textContent = '×';

            const actions = document.createElement('div');
            actions.className = 'rc-food-actions';
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            row.appendChild(handle);
            row.appendChild(dot);
            row.appendChild(info);
            row.appendChild(actions);

            row.addEventListener('click', e => {
                if (e.target.closest('.rc-drag-handle') || e.target.closest('.rc-food-edit-btn') || e.target.closest('.exercise-delete-btn') || e.target.closest('.rc-cat-picker-wrap')) return;
                const log = getTodayFoodLog();
                const wasSelected = !!log[food.id];
                if (wasSelected) { delete log[food.id]; } else { log[food.id] = 1; }
                setTodayFoodLog(log);
                if (!wasSelected) {
                    showRcScreen('rc-screen-calories');
                    renderFoodList();
                } else {
                    row.className = 'rc-food-row';
                    syncCaloriesToSlider();
                }
            });

            editBtn.addEventListener('click', e => {
                e.stopPropagation();
                openFoodEditInRow(food, row, () => openCatFoodScreen(_activeCat));
            });

            delBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (!delBtn.dataset.confirming) {
                    delBtn.dataset.confirming = '1';
                    delBtn.textContent = '?';
                    delBtn.classList.add('confirming');
                    setTimeout(() => {
                        if (delBtn.dataset.confirming) {
                            delBtn.textContent = '×';
                            delBtn.classList.remove('confirming');
                            delete delBtn.dataset.confirming;
                        }
                    }, 2500);
                } else {
                    const foods = getFoodLibrary();
                    const fi = foods.findIndex(f => f.id === food.id);
                    if (fi !== -1) foods.splice(fi, 1);
                    saveFoodLibrary(foods);
                    const log = getTodayFoodLog();
                    delete log[food.id];
                    setTodayFoodLog(log);
                    openCatFoodScreen(_activeCat);
                }
            });

            list.appendChild(row);
        });
    }
    showRcScreen('rc-screen-cat-foods');
}

document.getElementById('rcCatFoodsBack').addEventListener('click', () => { showRcScreen('rc-screen-past-foods'); });

document.getElementById('rcCalBack').addEventListener('click', () => { showRcScreen('rc-screen-type'); });

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const screens = {
        'rc-screen-cat-foods':  () => showRcScreen('rc-screen-past-foods'),
        'rc-screen-past-foods': () => showRcScreen('rc-screen-calories'),
        'rc-screen-add-food':   () => showRcScreen('rc-screen-calories'),
        'rc-screen-calories':   () => showRcScreen('rc-screen-type'),
    };
    for (const [id, fn] of Object.entries(screens)) {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') { e.stopPropagation(); fn(); return; }
    }
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── REFLECTION ───────────────────────────────────────────────────────────────
const RF_SECTIONS = ['happy', 'grateful', 'learned', 'helped', 'better'];

function getRfData() {
    const raw = Storage.getItem('reflection_321');
    const all = raw ? JSON.parse(raw) : {};
    const day = all[getDateKey(viewDate)] || {};
    const trim = arr => {
        const a = [...(arr && arr.length ? arr : [''])];
        while (a.length > 1 && !a[a.length - 1].trim()) a.pop();
        return a;
    };
    return {
        happy:    trim(day.happy),
        grateful: trim(day.grateful),
        learned:  trim(day.learned),
        helped:   trim(day.helped),
        better:   trim(day.better),
    };
}

function saveRfData(data) {
    const raw = Storage.getItem('reflection_321');
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = data;
    Storage.setItem('reflection_321', JSON.stringify(all));
}

function saveCurrentRfSection(section) {
    const body = document.getElementById('rf-body-' + section);
    const values = Array.from(body.querySelectorAll('.rf-input')).map(i => i.value);
    const data = getRfData();
    data[section] = values;
    saveRfData(data);
    updateRfSectionStyle(section, data);
    refreshChartAfterDataChange();
}

function updateRfSectionStyle(section, data) {
    const hasContent = data[section].some(v => v.trim());
    document.getElementById('rf-sec-' + section).classList.toggle('rf-has-content', hasContent);
}

function renumberRfBullets(section) {
    document.getElementById('rf-body-' + section)
        .querySelectorAll('.rf-bullet')
        .forEach((b, i) => { b.textContent = (i + 1) + '.'; });
}

let _rfEnterHandled = false;

function attachRfInputHandlers(section, input) {
    input.addEventListener('input', () => {
        if (input.value.endsWith('..')) {
            input.value = input.value.slice(0, -2);
            saveCurrentRfSection(section);
            const body = document.getElementById('rf-body-' + section);
            const inputs = Array.from(body.querySelectorAll('.rf-input'));
            const idx = inputs.indexOf(input);
            const newInput = insertRfRowAfter(section, idx);
            newInput.focus();
            return;
        }
        saveCurrentRfSection(section);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === '.') {
            if (input.value.endsWith('.')) {
                e.preventDefault();
                input.value = input.value.slice(0, -1);
                saveCurrentRfSection(section);
                const body = document.getElementById('rf-body-' + section);
                const inputs = Array.from(body.querySelectorAll('.rf-input'));
                const idx = inputs.indexOf(input);
                insertRfRowAfter(section, idx).focus();
            }
        } else if (e.key === 'Enter') {
            _rfEnterHandled = true;
            e.preventDefault();
            saveCurrentRfSection(section);
            const body = document.getElementById('rf-body-' + section);
            const inputs = Array.from(body.querySelectorAll('.rf-input'));
            const idx = inputs.indexOf(input);
            const newInput = insertRfRowAfter(section, idx);
            newInput.focus();

        } else if (e.key === 'Tab') {
            e.preventDefault();
            saveCurrentRfSection(section);
            rfCloseSection(section);
            const next = RF_SECTIONS[RF_SECTIONS.indexOf(section) + 1];
            if (next) rfOpenSection(next);

        } else if (e.key === 'Backspace' && input.value === '') {
            const body = document.getElementById('rf-body-' + section);
            const inputs = Array.from(body.querySelectorAll('.rf-input'));
            if (inputs.length > 1) {
                e.preventDefault();
                const idx = inputs.indexOf(input);
                input.closest('.rf-input-row').remove();
                renumberRfBullets(section);
                saveCurrentRfSection(section);
                inputs[Math.max(0, idx - 1)].focus();
            }
        }
    });

    // Mobile fallback: Android soft keyboards fire keydown with key:'Unidentified'
    // but keyup reliably has the correct key. The shared _rfEnterHandled flag
    // prevents double-firing on desktop (where keydown already handled it).
    input.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
            if (!_rfEnterHandled) {
                saveCurrentRfSection(section);
                const body = document.getElementById('rf-body-' + section);
                const inputs = Array.from(body.querySelectorAll('.rf-input'));
                const idx = inputs.indexOf(input);
                const newInput = insertRfRowAfter(section, idx);
                newInput.focus();
            }
            _rfEnterHandled = false;
        }
    });
}

function insertRfRowAfter(section, idx) {
    const body = document.getElementById('rf-body-' + section);
    const rows = Array.from(body.querySelectorAll('.rf-input-row'));
    const row = document.createElement('div');
    row.className = 'rf-input-row';
    const bullet = document.createElement('span');
    bullet.className = 'rf-bullet';
    const input = document.createElement('textarea');
    input.rows = 1;
    input.className = 'rf-input';
    row.appendChild(bullet);
    row.appendChild(input);
    if (idx < rows.length - 1) {
        rows[idx + 1].before(row);
    } else {
        body.appendChild(row);
    }
    renumberRfBullets(section);
    attachRfInputHandlers(section, input);
    return input;
}

function renderRfSection(section, values) {
    const body = document.getElementById('rf-body-' + section);
    body.innerHTML = '';
    values.forEach((val, i) => {
        const row = document.createElement('div');
        row.className = 'rf-input-row';
        const bullet = document.createElement('span');
        bullet.className = 'rf-bullet';
        bullet.textContent = (i + 1) + '.';
        const input = document.createElement('textarea');
        input.rows = 1;
        input.className = 'rf-input';
        input.value = val;
        row.appendChild(bullet);
        row.appendChild(input);
        body.appendChild(row);
        attachRfInputHandlers(section, input);
    });
}

function rfCloseSection(section) {
    document.getElementById('rf-body-' + section).classList.remove('rf-body-open');
    document.getElementById('rf-hdr-' + section).classList.remove('rf-open');
}

function rfOpenSection(section, delay) {
    const data = getRfData();
    renderRfSection(section, data[section]);
    const body = document.getElementById('rf-body-' + section);
    const hdr  = document.getElementById('rf-hdr-' + section);
    setTimeout(() => {
        body.classList.add('rf-body-open');
        hdr.classList.add('rf-open');
        setTimeout(() => {
            const first = body.querySelector('.rf-input');
            if (first) first.focus();
        }, 50);
    }, delay || 0);
}

function openReflectionModal() {
    const data = getRfData();
    RF_SECTIONS.forEach(section => {
        renderRfSection(section, data[section]);
        updateRfSectionStyle(section, data);
        rfCloseSection(section);
    });
    document.getElementById('reflectionModal').style.display = 'flex';
}

RF_SECTIONS.forEach(section => {
    document.getElementById('rf-hdr-' + section).addEventListener('click', () => {
        const body = document.getElementById('rf-body-' + section);
        const opening = !body.classList.contains('rf-body-open');
        const anyOpen = RF_SECTIONS.some(s =>
            document.getElementById('rf-body-' + s).classList.contains('rf-body-open')
        );
        RF_SECTIONS.forEach(s => {
            if (document.getElementById('rf-body-' + s).classList.contains('rf-body-open')) {
                saveCurrentRfSection(s);
            }
            rfCloseSection(s);
        });
        if (opening) rfOpenSection(section, anyOpen ? 320 : 0);
    });
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

document.querySelector('#mindfulnessModal .ex-title').addEventListener('click', () => {
    document.getElementById('mindfulnessModal').style.display = 'none';
    openMusicModal();
});

document.getElementById('mf-breath-slider').addEventListener('input', () => {
    const val = parseInt(document.getElementById('mf-breath-slider').value);
    document.getElementById('mf-breath-val').textContent = val;
    saveMfBreathing(val);
});
document.getElementById('mf-breath-slider').addEventListener('change', () => {
    refreshChartAfterDataChange();
});

document.getElementById('mf-focus-slider').addEventListener('input', () => {
    const val = parseInt(document.getElementById('mf-focus-slider').value);
    document.getElementById('mf-focus-val').textContent = val;
    saveMfFocus(val);
});
document.getElementById('mf-focus-slider').addEventListener('change', () => {
    refreshChartAfterDataChange();
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
        let pressStartX = 0, pressStartY = 0;
        row.addEventListener('contextmenu', e => e.preventDefault());
        row.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.exercise-delete-btn')) return;
            if (e.target.closest('.mindset-check')) return;
            if (panel.classList.contains('open')) return;
            renameTriggered = false;
            pressStartX = e.clientX; pressStartY = e.clientY;
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
        row.addEventListener('pointermove', (e) => {
            if (!pressTimer) return;
            if (Math.abs(e.clientX - pressStartX) > 8 || Math.abs(e.clientY - pressStartY) > 8) {
                clearTimeout(pressTimer); pressTimer = null;
            }
        });
        row.addEventListener('pointerup', () => { clearTimeout(pressTimer); pressTimer = null; });
        row.addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressTimer = null; });

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
            renderBookList();
        }
    );

    showMsScreen('ms-screen-notes');
    setTimeout(() => { const ta = document.getElementById('msBookNotes'); ta.focus(); autoGrow(ta); }, 50);
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
    setTimeout(() => { const ta = document.getElementById('avoidedNotes'); ta.focus(); autoGrow(ta); }, 50);
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


// ─── Lust status popup ───────────────────────────────────────────────────────
function getLustStatus() {
    const key = getDateKey(viewDate) + '__Lust';
    try {
        const all = JSON.parse(Storage.getItem(AVOIDED_ENTRIES_KEY)) || {};
        return (all[key] && all[key].status) || null;
    } catch(e) { return null; }
}

function saveLustStatus(status) {
    const key = getDateKey(viewDate) + '__Lust';
    let all = {};
    try { all = JSON.parse(Storage.getItem(AVOIDED_ENTRIES_KEY)) || {}; } catch(e) {}
    if (status) { all[key] = { status }; } else { delete all[key]; }
    Storage.setItem(AVOIDED_ENTRIES_KEY, JSON.stringify(all));
}

function toggleLustPopup(labelEl) {
    const popup = document.getElementById('lustPopup');
    if (popup.style.display !== 'none') { popup.style.display = 'none'; return; }
    const current = getLustStatus() || 'no';
    popup.dataset.selected = current;
    popup.querySelectorAll('.lust-option').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.status === current);
    });
    const rect = labelEl.getBoundingClientRect();
    popup.style.top  = (rect.bottom + 6) + 'px';
    popup.style.left = rect.left + 'px';
    popup.style.display = 'block';
}

document.querySelectorAll('.lust-option').forEach(btn => {
    btn.addEventListener('click', e => {
        e.stopPropagation();
        saveLustStatus(btn.dataset.status);
        const popup = document.getElementById('lustPopup');
        popup.dataset.selected = btn.dataset.status;
        popup.querySelectorAll('.lust-option').forEach(b => b.classList.toggle('selected', b === btn));
        popup.style.display = 'none';
        renderSinsMixer();
    });
});

document.addEventListener('click', () => {
    const popup = document.getElementById('lustPopup');
    if (popup) popup.style.display = 'none';
});

// ─── Reset current day by typing "reset" ─────────────────────────────────────

function resetCurrentDay() {
    const dateKey = getDateKey(viewDate);
    const prefix = dateKey + '__';

    function clearDayKey(storageKey) {
        const raw = Storage.getItem(storageKey);
        if (!raw) return;
        const all = JSON.parse(raw);
        delete all[dateKey];
        Storage.setItem(storageKey, JSON.stringify(all));
    }

    function clearPrefixKeys(storageKey) {
        const raw = Storage.getItem(storageKey);
        if (!raw) return;
        const all = JSON.parse(raw);
        Object.keys(all).forEach(k => { if (k.startsWith(prefix)) delete all[k]; });
        Storage.setItem(storageKey, JSON.stringify(all));
    }

    clearDayKey(STORAGE_KEY);
    clearDayKey(SPIRITUAL_KEY);
    clearDayKey(RECOVERY_KEY);
    clearDayKey('reflection_321');
    clearDayKey('mindfulness_minutes');
    clearDayKey('mindfulness_breathing');
    clearDayKey('mindfulness_focus');

    clearPrefixKeys(EXERCISE_LOGS_KEY);
    clearPrefixKeys(EXERCISE_CHECKS_KEY);
    clearPrefixKeys('mobility_other_checks');
    clearPrefixKeys('mobility_other_notes');
    clearPrefixKeys(MOBILITY_SIMPLE_KEY);
    clearPrefixKeys(MINDSET_NOTES_KEY);
    clearPrefixKeys(MINDSET_CHECKS_KEY);
    clearPrefixKeys(AVOIDED_ENTRIES_KEY);
    clearPrefixKeys(VIRTUE_ENTRIES_KEY);

    loadDayData();
    renderCalendar();
}

(function () {
    let buf = '';
    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        buf = (buf + e.key).slice(-5);
        if (buf === 'reset') {
            buf = '';
            resetCurrentDay();
        }
    });
})();

(function () {
    let buf = '';
    let active = false;
    let wakeLock = null;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'display:none;position:fixed;inset:0;background:white;z-index:99999;';
    document.body.appendChild(overlay);

    async function acquireWakeLock() {
        if ('wakeLock' in navigator) {
            try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
        }
    }
    function releaseWakeLock() {
        if (wakeLock) { wakeLock.release(); wakeLock = null; }
    }

    document.addEventListener('visibilitychange', () => {
        if (active && document.visibilityState === 'visible') acquireWakeLock();
    });

    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        buf = (buf + e.key).slice(-5);
        if (buf === 'white') {
            buf = '';
            active = !active;
            if (active) {
                overlay.style.display = 'block';
                document.body.style.cursor = 'none';
                document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
                acquireWakeLock();
            } else {
                overlay.style.display = 'none';
                document.body.style.cursor = '';
                document.fullscreenElement && document.exitFullscreen();
                releaseWakeLock();
            }
        }
    });
})();


// ─── Weight Popup ─────────────────────────────────────────────────────────────
// Stored per-day so history is tracked. Opening a day with no recorded weight
// falls back to the most recent previous entry so the value carries forward.
const WEIGHT_KEY = 'body_weight_daily';

function getWeightAllDays() {
    const raw = Storage.getItem(WEIGHT_KEY);
    return raw ? JSON.parse(raw) : {};
}

function getWeight() {
    const all = getWeightAllDays();
    const today = getDateKey(viewDate);
    if (all[today] != null) return all[today];
    // Fall back to most recent past entry
    const past = Object.keys(all).filter(k => k < today).sort();
    return past.length ? all[past[past.length - 1]] : 70.0;
}

function saveWeight(val) {
    const all = getWeightAllDays();
    all[getDateKey(viewDate)] = Math.round(val * 10) / 10;
    Storage.setItem(WEIGHT_KEY, JSON.stringify(all));
}

(function () {
    const popup = document.getElementById('weightPopup');
    const valueEl = document.getElementById('weight-value');

    function refresh() { valueEl.textContent = getWeight().toFixed(1); }
    function show() { refresh(); popup.style.display = 'block'; }
    function hide() { popup.style.display = 'none'; }

    document.querySelector('#ex-screen-muscles .ex-title').addEventListener('click', show);
    document.getElementById('weight-minus').addEventListener('click', () => { saveWeight(getWeight() - 0.5); refresh(); });
    document.getElementById('weight-plus').addEventListener('click',  () => { saveWeight(getWeight() + 0.5); refresh(); });
    document.getElementById('weight-close').addEventListener('click', hide);

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && popup.style.display !== 'none') { e.stopPropagation(); hide(); }
    });
})();


// ─── Prayer Counter ───────────────────────────────────────────────────────────
const PRAYER_KEY = 'prayer_count';

function getPrayerCount() {
    const raw = Storage.getItem(PRAYER_KEY);
    return raw ? (JSON.parse(raw)[getDateKey(viewDate)] || 0) : 0;
}
function savePrayerCount(n) {
    const raw = Storage.getItem(PRAYER_KEY);
    const all = raw ? JSON.parse(raw) : {};
    if (n > 0) { all[getDateKey(viewDate)] = n; } else { delete all[getDateKey(viewDate)]; }
    Storage.setItem(PRAYER_KEY, JSON.stringify(all));
}

(function () {
    const popup = document.getElementById('prayerPopup');
    const valueEl = document.getElementById('prayer-value');

    function refresh() { valueEl.textContent = getPrayerCount(); }
    function show() { refresh(); popup.style.display = 'block'; }
    function hide() { popup.style.display = 'none'; }

    document.querySelector('#sp-screen-list .ex-title').addEventListener('click', show);
    document.getElementById('prayer-minus').addEventListener('click', () => { savePrayerCount(Math.max(0, getPrayerCount() - 1)); refresh(); });
    document.getElementById('prayer-plus').addEventListener('click',  () => { savePrayerCount(getPrayerCount() + 1); refresh(); });
    document.getElementById('prayer-close').addEventListener('click', hide);

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && popup.style.display !== 'none') { e.stopPropagation(); hide(); }
    });
})();


// ─── Music Modal ──────────────────────────────────────────────────────────────
// Paste your YouTube video URLs below, one per line inside the array.
// Full watch URLs (https://www.youtube.com/watch?v=XXXXX) and
// short URLs (https://youtu.be/XXXXX) both work.
const YOUTUBE_VIDEOS = [
    'https://www.youtube.com/watch?v=gnV-8pkILF0',
    'https://www.youtube.com/watch?v=FAsrHKXHh4o',
    'https://www.youtube.com/watch?v=xETEYG-az9E',
    'https://www.youtube.com/watch?v=OVlayZ2LVYE',
    'https://www.youtube.com/watch?v=qVdMh98w6_Q',
    'https://www.youtube.com/watch?v=65A7_eNDcks',
    'https://www.youtube.com/watch?v=0fStWP79Z5A',
    'https://www.youtube.com/watch?v=XX5nL9EJiWU',
    'https://www.youtube.com/watch?v=tKmwR2jo0zw',
    'https://www.youtube.com/watch?v=MN98FGYo_5c',
    'https://www.youtube.com/watch?v=RFkE8GIJHp8',
    'https://www.youtube.com/watch?v=tUNbhYcY9Ik',
    'https://www.youtube.com/watch?v=UxY6kZxutrs',
    'https://www.youtube.com/watch?v=oQR7J-6Oh14',
    'https://www.youtube.com/watch?v=pffI2Lmq00c',
    'https://www.youtube.com/watch?v=_mfZNpCcdVI',
    'https://www.youtube.com/watch?v=GJDUWw94Sig',
    'https://www.youtube.com/watch?v=bmgPIGqL_YM',
    'https://www.youtube.com/watch?v=TBaXTbtQ_UE',
    'https://www.youtube.com/watch?v=p_SxDBKaVvY',
    'https://www.youtube.com/watch?v=SwJ435IW4JQ',
    'https://www.youtube.com/watch?v=e28jRrYm1nM',
    'https://www.youtube.com/watch?v=7t4FwxR_ymw',
    'https://www.youtube.com/watch?v=-lJMxQbeWmE',
    'https://www.youtube.com/watch?v=M4RpqFzFl14',
];

function extractYouTubeId(url) {
    const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

function openMusicModal() {
    const list = document.getElementById('music-videos');
    list.innerHTML = '';
    if (YOUTUBE_VIDEOS.length === 0) {
        list.innerHTML = '<p class="music-empty">No videos added yet.</p>';
        document.getElementById('musicModal').style.display = 'flex';
        return;
    }
    YOUTUBE_VIDEOS.forEach(url => {
        const id = extractYouTubeId(url);
        if (!id) return;

        const item = document.createElement('div');
        item.className = 'music-thumb-item';

        const a = document.createElement('a');
        a.href = 'https://www.youtube.com/watch?v=' + id;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'music-thumb-link';

        const img = document.createElement('img');
        img.className = 'music-thumb-img';
        img.src = 'https://img.youtube.com/vi/' + id + '/mqdefault.jpg';
        img.loading = 'lazy';

        const overlay = document.createElement('div');
        overlay.className = 'music-thumb-play';
        overlay.innerHTML = '&#9654;';

        a.appendChild(img);
        a.appendChild(overlay);

        const title = document.createElement('div');
        title.className = 'music-thumb-title';
        title.textContent = '…';

        item.appendChild(a);
        item.appendChild(title);
        list.appendChild(item);

        fetch('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + id + '&format=json')
            .then(r => r.json())
            .then(d => { title.textContent = (d.title || '').replace(/\s*\(.*?\)\s*/g, '').trim(); })
            .catch(() => { title.textContent = ''; });
    });
    document.getElementById('musicModal').style.display = 'flex';
}

document.getElementById('day-name').addEventListener('click', openAnalytics);
document.getElementById('closeMusicModal').addEventListener('click', () => {
    document.getElementById('musicModal').style.display = 'none';
});

// ─── Gym Timer ────────────────────────────────────────────────────────────────
(function () {
    const DURATION = 120;
    let remaining = DURATION;
    let interval = null;

    const timerEl  = document.getElementById('gymTimer');
    const displayEl = document.getElementById('gymTimerDisplay');

    function fmt(s) {
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function updateDisplay() {
        displayEl.textContent = fmt(remaining);
        displayEl.classList.toggle('gym-timer-done', remaining === 0);
    }

    function startCountdown() {
        if (interval) clearInterval(interval);
        interval = setInterval(() => {
            if (remaining <= 0) {
                clearInterval(interval); interval = null;
                updateDisplay();
                return;
            }
            remaining--;
            updateDisplay();
        }, 1000);
    }

    function reset() {
        if (interval) clearInterval(interval);
        interval = null;
        remaining = DURATION;
        displayEl.classList.remove('gym-timer-done');
        updateDisplay();
        startCountdown();
    }

    function openTimer() {
        timerEl.style.display = 'block';
        reset();
    }

    // ── Drag + click ─────────────────────────────────────────────────────────
    let dragActive = false, didDrag = false;
    let startX, startY, originLeft, originTop;

    timerEl.addEventListener('pointerdown', e => {
        dragActive = true; didDrag = false;
        const rect = timerEl.getBoundingClientRect();
        timerEl.style.left   = rect.left + 'px';
        timerEl.style.top    = rect.top  + 'px';
        timerEl.style.right  = 'auto';
        timerEl.style.bottom = 'auto';
        originLeft = rect.left; originTop = rect.top;
        startX = e.clientX;    startY = e.clientY;
        timerEl.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    timerEl.addEventListener('pointermove', e => {
        if (!dragActive) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDrag = true;
        timerEl.style.left = (originLeft + dx) + 'px';
        timerEl.style.top  = (originTop  + dy) + 'px';
    });

    timerEl.addEventListener('pointerup', () => {
        if (!dragActive) return;
        dragActive = false;
        if (!didDrag) { reset(); return; }
        // Dismiss if dropped over the muscle title
        const title = document.getElementById('ex-muscle-title');
        const tr = timerEl.getBoundingClientRect();
        const lr = title.getBoundingClientRect();
        const overlaps = tr.left < lr.right && tr.right > lr.left &&
                         tr.top  < lr.bottom && tr.bottom > lr.top;
        if (overlaps) {
            if (interval) clearInterval(interval);
            interval = null;
            timerEl.style.display = 'none';
        }
    });

    document.getElementById('ex-muscle-title').addEventListener('click', openTimer);

    updateDisplay();
})();


// ─── ANALYTICS ────────────────────────────────────────────────────────────────

let _analyticsPeriod = 'week';

// ─── Data helpers ──────────────────────────────────────────────────────────────

function getAnalyticsDates(period) {
    const end = new Date();
    const start = new Date();
    const days = period === 'week' ? 6 : period === 'month' ? 29 : 364;
    start.setDate(start.getDate() - days);
    const dates = [];
    const d = new Date(start);
    while (d <= end) {
        dates.push(getDateKey(new Date(d)));
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

function analyticsScoreData(dates) {
    const raw = Storage.getItem(STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return dates.map(date => {
        const day = all[date] || {};
        const vitals = Array.isArray(day) ? day : (day.vitals || []);
        const total = vitals.reduce((s, v) => s + (v && v.value != null ? v.value : 0), 0);
        const byCategory = {};
        defaultValues.forEach((def, i) => {
            byCategory[def.name] = (vitals[i] && vitals[i].value != null) ? vitals[i].value : 0;
        });
        return { date, total: total > 0 ? total : null, byCategory };
    });
}

function analyticsWeightData(dates) {
    const all = JSON.parse(Storage.getItem(WEIGHT_KEY) || '{}');
    const today = getDateKey(new Date());
    const sortedKeys = Object.keys(all).sort();
    return dates.map(d => {
        if (all[d] != null) return { date: d, value: all[d] };
        if (d > today)      return { date: d, value: null };
        // Carry forward the most recent recorded weight
        const past = sortedKeys.filter(k => k <= d).pop();
        return { date: d, value: past != null ? all[past] : null };
    });
}

function analyticsSleepData(dates) {
    const all = JSON.parse(Storage.getItem(RECOVERY_KEY) || '{}');
    return dates.map(d => ({ date: d, value: (all[d] || {}).sleep ?? null }));
}

function analyticsHydrationData(dates) {
    const all = JSON.parse(Storage.getItem(RECOVERY_KEY) || '{}');
    return dates.map(d => {
        const h = (all[d] || {}).hydration;
        return { date: d, value: h != null ? (typeof h === 'boolean' ? 5 : +h) : null };
    });
}

function analyticsCalorieData(dates) {
    const all = JSON.parse(Storage.getItem(RECOVERY_KEY) || '{}');
    return dates.map(d => ({
        date: d,
        cal:  (all[d] || {}).nutrition ?? null,
        prot: (all[d] || {}).protein   ?? null,
    }));
}

function analyticsMindfulnessData(dates) {
    const all = JSON.parse(Storage.getItem('mindfulness_minutes') || '{}');
    return dates.map(d => ({ date: d, value: all[d] ?? null }));
}

function analyticsPrayerData(dates) {
    const all = JSON.parse(Storage.getItem(PRAYER_KEY) || '{}');
    return dates.map(d => ({ date: d, value: all[d] ?? null }));
}

function analyticsRecoveryStats(dates) {
    const all = JSON.parse(Storage.getItem(RECOVERY_KEY) || '{}');
    let cryo = 0, creatine = 0, days = 0;
    dates.forEach(d => {
        const day = all[d] || {};
        if (Object.keys(day).length > 0) {
            days++;
            if (day.cryotherapy) cryo++;
            if (day.creatine)    creatine++;
        }
    });
    return { cryo, creatine, days, total: dates.length };
}

function analyticsStreakLength(scoreData) {
    let max = 0, cur = 0;
    scoreData.forEach(d => {
        if (d.total != null && d.total > 0) { cur++; max = Math.max(max, cur); }
        else cur = 0;
    });
    return max;
}

// ─── Chart utilities ───────────────────────────────────────────────────────────

function _aDateLabel(dateStr, total) {
    const parts = dateStr.split('-').map(Number);
    const m = parts[1], day = parts[2];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (total <= 8)  return months[m-1] + ' ' + day;
    if (total <= 31) return String(day);
    return months[m-1];
}

function _aLabelIndices(n) {
    if (n <= 8)  return Array.from({ length: n }, (_, i) => i);
    if (n <= 31) return [0, Math.round(n * 0.25), Math.round(n * 0.5), Math.round(n * 0.75), n - 1];
    return [0, Math.round(n/6), Math.round(n/3), Math.round(n/2), Math.round(2*n/3), Math.round(5*n/6), n - 1];
}

function _emptyChartSVG(W, H) {
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">` +
        `<text x="${W/2}" y="${H/2+4}" text-anchor="middle" fill="rgba(240,236,228,0.35)" font-size="11" font-family="-apple-system,sans-serif" letter-spacing="1">NO DATA FOR PERIOD</text></svg>`;
}

// ─── Line chart ────────────────────────────────────────────────────────────────

function _fmtY(v) {
    if (v === 0) return '0';
    if (v >= 10000) return Math.round(v / 1000) + 'k';
    if (v >= 1000)  return (Math.round(v / 100) / 10) + 'k';
    return v % 1 === 0 ? String(Math.round(v)) : v.toFixed(1);
}

function makeLineSVG(points, color, opts) {
    const { min = 0, maxVal = null, showDots = true, targetLine = null, chartH = 110 } = opts || {};
    const W = 440, H = chartH, PL = 28, PR = 6, PT = 6, PB = 20;
    const CW = W - PL - PR, CH = H - PT - PB;
    const vals = points.map(p => p.value).filter(v => v != null);
    if (!vals.length) return _emptyChartSVG(W, H);

    const dMax = maxVal != null ? maxVal : (Math.max(...vals) * 1.15 || 1);
    const dMin = typeof min === 'number' ? min : Math.min(...vals);
    const dRange = (dMax - dMin) || 1;

    const toX = i => PL + (i / Math.max(1, points.length - 1)) * CW;
    const toY = v => PT + CH - ((v - dMin) / dRange) * CH;

    const vps = points.map((p, i) => ({ i, v: p.value })).filter(p => p.v != null);

    let line = '', area = '';
    if (vps.length >= 2) {
        const pts = vps.map(p => [toX(p.i), toY(p.v)]);
        line = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let k = 1; k < pts.length; k++) {
            const cpx = ((pts[k-1][0] + pts[k][0]) / 2).toFixed(1);
            line += ` C ${cpx} ${pts[k-1][1].toFixed(1)} ${cpx} ${pts[k][1].toFixed(1)} ${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)}`;
        }
        const baseY = (PT + CH).toFixed(1);
        area = line + ` L ${pts[pts.length-1][0].toFixed(1)} ${baseY} L ${pts[0][0].toFixed(1)} ${baseY} Z`;
    }

    const gid = 'alg' + Math.random().toString(36).slice(2, 7);

    // Grid + Y-axis labels (3 ticks: bottom, mid, top)
    const gridSVG = [0, 0.5, 1].map(f => {
        const y   = (PT + CH * (1 - f)).toFixed(1);
        const val = dMin + f * dRange;
        return `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>` +
               `<text x="${PL - 4}" y="${(parseFloat(y) + 3).toFixed(1)}" text-anchor="end" fill="rgba(240,236,228,0.38)" font-size="7" font-family="-apple-system,sans-serif">${_fmtY(val)}</text>`;
    }).join('');

    const li = _aLabelIndices(points.length);
    const labelsSVG = li.filter(i => i < points.length).map(i =>
        `<text x="${toX(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="rgba(240,236,228,0.38)" font-size="8" font-family="-apple-system,sans-serif">${_aDateLabel(points[i].date, points.length)}</text>`
    ).join('');

    const dotR = points.length <= 14 ? 2 : 1.5;
    const dotsSVG = showDots ? vps.map(p =>
        `<circle cx="${toX(p.i).toFixed(1)}" cy="${toY(p.v).toFixed(1)}" r="${dotR}" fill="${color}"/>`
    ).join('') : '';

    const targetSVG = targetLine != null ? `<line x1="${PL}" y1="${toY(targetLine).toFixed(1)}" x2="${W-PR}" y2="${toY(targetLine).toFixed(1)}" stroke="rgba(240,236,228,0.15)" stroke-width="1" stroke-dasharray="4,3"/>` : '';

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
  <stop offset="100%" stop-color="${color}" stop-opacity="0.03"/>
</linearGradient></defs>
${gridSVG}${targetSVG}
${area  ? `<path d="${area}"  fill="url(#${gid})"/>` : ''}
${line  ? `<path d="${line}"  fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
${dotsSVG}${labelsSVG}
</svg>`;
}

// ─── Bar chart ─────────────────────────────────────────────────────────────────

function makeBarSVG(points, color, opts) {
    const { maxVal = null, targetLine = null } = opts || {};
    const W = 440, H = 90, PL = 4, PR = 4, PT = 8, PB = 26;
    const CW = W - PL - PR, CH = H - PT - PB;
    const vals = points.map(p => p.value).filter(v => v != null && v > 0);
    if (!vals.length) return _emptyChartSVG(W, H);

    const dMax = maxVal != null ? maxVal : (Math.max(...vals) * 1.15 || 1);
    const bW = CW / points.length;
    const gap = Math.max(0.5, bW * 0.2);

    const barsSVG = points.map((p, i) => {
        if (!p.value || p.value <= 0) return '';
        const x = (PL + i * bW + gap / 2).toFixed(1);
        const w = Math.max(1, bW - gap).toFixed(1);
        const h = Math.max(1, (p.value / dMax) * CH).toFixed(1);
        const y = (PT + CH - (p.value / dMax) * CH).toFixed(1);
        return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${color}" opacity="0.85"/>`;
    }).join('');

    const li = _aLabelIndices(points.length);
    const labelsSVG = li.filter(i => i < points.length).map(i => {
        const x = (PL + i * bW + bW / 2).toFixed(1);
        return `<text x="${x}" y="${H - 5}" text-anchor="middle" fill="rgba(240,236,228,0.38)" font-size="8" font-family="-apple-system,sans-serif">${_aDateLabel(points[i].date, points.length)}</text>`;
    }).join('');

    const tY = targetLine != null && targetLine <= dMax
        ? (PT + CH - (targetLine / dMax) * CH).toFixed(1) : null;
    const targetSVG = tY ? `<line x1="${PL}" y1="${tY}" x2="${W-PR}" y2="${tY}" stroke="rgba(61,220,132,0.42)" stroke-width="1" stroke-dasharray="4,3"/>` : '';

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">
${barsSVG}${targetSVG}${labelsSVG}
</svg>`;
}

// ─── Dual bar chart (calories + protein) ──────────────────────────────────────

function makeDualBarSVG(points) {
    const W = 440, H = 100, PL = 4, PR = 4, PT = 18, PB = 26;
    const CW = W - PL - PR, CH = H - PT - PB;
    const cals  = points.map(p => p.cal ).filter(v => v != null && v > 0);
    const prots = points.map(p => p.prot).filter(v => v != null && v > 0);
    if (!cals.length && !prots.length) return _emptyChartSVG(W, H);

    const maxCal  = cals.length  ? Math.max(...cals)  * 1.15 : 1;
    const maxProt = prots.length ? Math.max(...prots) * 1.15 : 1;
    const n = points.length;
    const grpW = CW / n;
    const barW = Math.max(1, (grpW - 2) / 2);

    const barsSVG = points.map((p, i) => {
        const x0 = PL + i * grpW;
        let out = '';
        if (p.cal  > 0) {
            const h = Math.max(1, (p.cal  / maxCal)  * CH).toFixed(1);
            const y = (PT + CH - (p.cal  / maxCal)  * CH).toFixed(1);
            out += `<rect x="${(x0 + 0.5).toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${h}" rx="1.5" fill="#c9a96e" opacity="0.85"/>`;
        }
        if (p.prot > 0) {
            const h = Math.max(1, (p.prot / maxProt) * CH).toFixed(1);
            const y = (PT + CH - (p.prot / maxProt) * CH).toFixed(1);
            out += `<rect x="${(x0 + barW + 1).toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${h}" rx="1.5" fill="#60a5fa" opacity="0.85"/>`;
        }
        return out;
    }).join('');

    const li = _aLabelIndices(n);
    const labelsSVG = li.filter(i => i < points.length).map(i => {
        const x = (PL + i * grpW + grpW / 2).toFixed(1);
        return `<text x="${x}" y="${H - 5}" text-anchor="middle" fill="rgba(240,236,228,0.38)" font-size="8" font-family="-apple-system,sans-serif">${_aDateLabel(points[i].date, n)}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">
<text x="${PL+4}"    y="12" fill="rgba(201,169,110,0.65)" font-size="7.5" font-family="-apple-system,sans-serif">&#9679; CALORIES</text>
<text x="${PL+90}"   y="12" fill="rgba(96,165,250,0.65)"  font-size="7.5" font-family="-apple-system,sans-serif">&#9679; PROTEIN (g)</text>
${barsSVG}${labelsSVG}
</svg>`;
}

// ─── Donut / pie chart ─────────────────────────────────────────────────────────

function makeDonutSVG(segments, centerLines) {
    const W = 160, H = 160, cx = 80, cy = 80, outerR = 63, innerR = 38;
    const total = segments.reduce((s, g) => s + (g.value || 0), 0);
    if (!total) return _emptyChartSVG(W, H);

    let angle = -Math.PI / 2;
    const pathsSVG = segments.map(seg => {
        if (!seg.value) return '';
        const sweep = (seg.value / total) * 2 * Math.PI;
        const end   = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const [x1, y1] = [cx + outerR * Math.cos(angle), cy + outerR * Math.sin(angle)];
        const [x2, y2] = [cx + outerR * Math.cos(end),   cy + outerR * Math.sin(end)];
        const [x3, y3] = [cx + innerR * Math.cos(end),   cy + innerR * Math.sin(end)];
        const [x4, y4] = [cx + innerR * Math.cos(angle), cy + innerR * Math.sin(angle)];
        const d = `M${x1.toFixed(2)},${y1.toFixed(2)} A${outerR},${outerR} 0 ${large},1 ${x2.toFixed(2)},${y2.toFixed(2)} L${x3.toFixed(2)},${y3.toFixed(2)} A${innerR},${innerR} 0 ${large},0 ${x4.toFixed(2)},${y4.toFixed(2)}Z`;
        angle = end;
        return `<path d="${d}" fill="${seg.color}"/>`;
    }).join('');

    const linesArr = (centerLines || []);
    const centerSVG = linesArr.map((l, i) => {
        const dy = cy + (i - (linesArr.length - 1) / 2) * 14;
        return `<text x="${cx}" y="${dy + 4}" text-anchor="middle" fill="rgba(240,236,228,0.65)" font-size="10" font-family="-apple-system,sans-serif">${l}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="160" height="160" class="analytics-chart-svg" style="max-width:160px" xmlns="http://www.w3.org/2000/svg">
<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="var(--surface-3)"/>
${pathsSVG}
<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="var(--surface)"/>
${centerSVG}
</svg>`;
}

// ─── Mini radar ────────────────────────────────────────────────────────────────

function makeMiniRadarSVG(catAvgs) {
    const W = 160, H = 160, cx = 80, cy = 80, maxR = 58;
    const n = defaultValues.length;
    const getP = (i, v) => {
        const a = (2 * Math.PI / n) * i - Math.PI / 2;
        const r = (v / 10) * maxR;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };

    const gridSVG = [2, 4, 6, 8, 10].map(v =>
        `<circle cx="${cx}" cy="${cy}" r="${(v/10)*maxR}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`
    ).join('') + defaultValues.map((_, i) => {
        const a = (2 * Math.PI / n) * i - Math.PI / 2;
        return `<line x1="${cx}" y1="${cy}" x2="${(cx + maxR * Math.cos(a)).toFixed(2)}" y2="${(cy + maxR * Math.sin(a)).toFixed(2)}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
    }).join('');

    const polyPts = defaultValues.map((def, i) => {
        const [x, y] = getP(i, catAvgs[def.name] || 0);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');

    const labelR = maxR + 15;
    const labelsSVG = defaultValues.map((def, i) => {
        const a  = (2 * Math.PI / n) * i - Math.PI / 2;
        const lx = cx + labelR * Math.cos(a);
        const ly = cy + labelR * Math.sin(a);
        const anchor = Math.cos(a) > 0.3 ? 'start' : (Math.cos(a) < -0.3 ? 'end' : 'middle');
        return `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}" fill="rgba(240,236,228,0.45)" font-size="6.5" font-family="-apple-system,sans-serif">${def.name.slice(0, 5).toUpperCase()}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="160" height="160" class="analytics-chart-svg" style="max-width:160px" xmlns="http://www.w3.org/2000/svg">
${gridSVG}
<polygon points="${polyPts}" fill="rgba(201,169,110,0.12)" stroke="rgba(201,169,110,0.65)" stroke-width="1.5" stroke-linejoin="round"/>
${labelsSVG}
</svg>`;
}

// ─── 7-category multi-line chart ──────────────────────────────────────────────

const CAT_LINE_COLORS = [
    '#c9a96e',  // Spirituality  — gold
    '#5dbea3',  // Recovery      — teal
    '#7aa8d4',  // Mindset       — steel blue
    '#a87ed4',  // Mindfulness   — purple
    '#d47a7a',  // Reflection    — rose
    '#d4c05a',  // Mobility      — amber
    '#d4916a',  // Creativity    — warm orange
];

function makeCategoryTrendSVG(scoreData) {
    const W = 440, H = 135, PL = 28, PR = 6, PT = 6, PB = 20;
    const CW = W - PL - PR, CH = H - PT - PB;
    const n = scoreData.length;
    if (!n) return _emptyChartSVG(W, H);

    const toX = i => PL + (i / Math.max(1, n - 1)) * CW;
    const toY = v => PT + CH - (v / 10) * CH;   // always 0–10 scale

    // Grid + Y labels at 0, 5, 10
    const gridSVG = [0, 0.5, 1].map(f => {
        const y   = (PT + CH * (1 - f)).toFixed(1);
        const val = f * 10;
        return `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>` +
               `<text x="${PL-4}" y="${(parseFloat(y)+3).toFixed(1)}" text-anchor="end" fill="rgba(240,236,228,0.38)" font-size="7" font-family="-apple-system,sans-serif">${val}</text>`;
    }).join('');

    // One smooth path per category
    const linesSVG = defaultValues.map((def, ci) => {
        const color = CAT_LINE_COLORS[ci];
        const vps = scoreData.map((d, i) => ({ i, v: d.byCategory[def.name] }))
                             .filter(p => p.v > 0);
        if (vps.length < 2) return '';
        const pts = vps.map(p => [toX(p.i), toY(p.v)]);
        let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let k = 1; k < pts.length; k++) {
            const cpx = ((pts[k-1][0] + pts[k][0]) / 2).toFixed(1);
            d += ` C ${cpx} ${pts[k-1][1].toFixed(1)} ${cpx} ${pts[k][1].toFixed(1)} ${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)}`;
        }
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');

    // X-axis date labels
    const li = _aLabelIndices(n);
    const xLabelsSVG = li.filter(i => i < n).map(i =>
        `<text x="${toX(i).toFixed(1)}" y="${H-5}" text-anchor="middle" fill="rgba(240,236,228,0.35)" font-size="8" font-family="-apple-system,sans-serif">${_aDateLabel(scoreData[i].date, n)}</text>`
    ).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">
${gridSVG}${linesSVG}${xLabelsSVG}
</svg>`;
}

// Builds the legend HTML that sits below makeCategoryTrendSVG
function makeCatLegendHTML() {
    return `<div class="cat-legend">${
        defaultValues.map((def, i) =>
            `<span class="cat-legend-item" style="color:${CAT_LINE_COLORS[i]}">&#9679; ${def.name}</span>`
        ).join('')
    }</div>`;
}

// ─── 7-sin multi-line chart ────────────────────────────────────────────────────

const SIN_LINE_COLORS = [
    '#e07878',  // Pride     — red
    '#d4a85a',  // Greed     — amber
    '#e080a8',  // Lust      — pink
    '#78c078',  // Envy      — green
    '#c09870',  // Gluttony  — brown
    '#e05858',  // Wrath     — dark red
    '#8898b8',  // Sloth     — slate
];

function _analyticsLevels(key, dates) {
    let parsed = {};
    try { parsed = JSON.parse(Storage.getItem(key) || '{}'); } catch(e) {}
    if (!_looksLikePerDay(parsed)) {
        return dates.map(d => ({ date: d, levels: parsed }));
    }
    // Per-day with most-recent-past fallback so unchanged days carry forward
    return dates.map(d => ({ date: d, levels: _mostRecentLevels(parsed, d) }));
}

function analyticsSinData(dates)    { return _analyticsLevels(SIN_LEVELS_KEY,    dates); }
function analyticsVirtueData(dates) { return _analyticsLevels(VIRTUE_LEVELS_KEY, dates); }

function makeSinTrendSVG(sinData) {
    const W = 440, H = 92, PL = 28, PR = 6, PT = 6, PB = 20;
    const CW = W - PL - PR, CH = H - PT - PB;
    const n = sinData.length;
    if (!n) return _emptyChartSVG(W, H);

    const toX = i => PL + (i / Math.max(1, n - 1)) * CW;
    const toY = v => PT + CH - (v / 10) * CH;

    const gridSVG = [0, 0.5, 1].map(f => {
        const y = (PT + CH * (1 - f)).toFixed(1);
        return `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>` +
               `<text x="${PL-4}" y="${(parseFloat(y)+3).toFixed(1)}" text-anchor="end" fill="rgba(240,236,228,0.38)" font-size="7" font-family="-apple-system,sans-serif">${f*10}</text>`;
    }).join('');

    const linesSVG = avoidedActivitiesList.map((name, ci) => {
        const color = SIN_LINE_COLORS[ci];
        const vps = sinData.map((d, i) => ({ i, v: d.levels[name] || 0 })).filter(p => p.v > 0);
        if (vps.length < 2) return '';
        const pts = vps.map(p => [toX(p.i), toY(p.v)]);
        let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let k = 1; k < pts.length; k++) {
            const cpx = ((pts[k-1][0] + pts[k][0]) / 2).toFixed(1);
            d += ` C ${cpx} ${pts[k-1][1].toFixed(1)} ${cpx} ${pts[k][1].toFixed(1)} ${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)}`;
        }
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');

    const li = _aLabelIndices(n);
    const xLabelsSVG = li.filter(i => i < n).map(i =>
        `<text x="${toX(i).toFixed(1)}" y="${H-5}" text-anchor="middle" fill="rgba(240,236,228,0.35)" font-size="8" font-family="-apple-system,sans-serif">${_aDateLabel(sinData[i].date, n)}</text>`
    ).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">
${gridSVG}${linesSVG}${xLabelsSVG}
</svg>`;
}

function makeSinLegendHTML() {
    return `<div class="cat-legend">${
        avoidedActivitiesList.map((name, i) =>
            `<span class="cat-legend-item" style="color:${SIN_LINE_COLORS[i]}">&#9679; ${name}</span>`
        ).join('')
    }</div>`;
}

// ─── 7-virtue multi-line chart ─────────────────────────────────────────────────

const VIRTUE_LINE_COLORS = [
    '#7ab4d4',  // Faith      — sky blue
    '#78d4a8',  // Hope       — mint
    '#d4b87a',  // Charity    — warm gold
    '#b07ad4',  // Patience   — violet
    '#7ad4c8',  // Humility   — teal
    '#d4d07a',  // Diligence  — yellow
    '#7aa8d4',  // Integrity  — steel blue
];

function makeVirtueTrendSVG(virtueData) {
    const W = 440, H = 92, PL = 28, PR = 6, PT = 6, PB = 20;
    const CW = W - PL - PR, CH = H - PT - PB;
    const n = virtueData.length;
    if (!n) return _emptyChartSVG(W, H);

    const toX = i => PL + (i / Math.max(1, n - 1)) * CW;
    const toY = v => PT + CH - (v / 10) * CH;

    const gridSVG = [0, 0.5, 1].map(f => {
        const y = (PT + CH * (1 - f)).toFixed(1);
        return `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>` +
               `<text x="${PL-4}" y="${(parseFloat(y)+3).toFixed(1)}" text-anchor="end" fill="rgba(240,236,228,0.38)" font-size="7" font-family="-apple-system,sans-serif">${f*10}</text>`;
    }).join('');

    const linesSVG = christLikeAttributesList.map((name, ci) => {
        const color = VIRTUE_LINE_COLORS[ci];
        const vps = virtueData.map((d, i) => ({ i, v: d.levels[name] || 0 })).filter(p => p.v > 0);
        if (vps.length < 2) return '';
        const pts = vps.map(p => [toX(p.i), toY(p.v)]);
        let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let k = 1; k < pts.length; k++) {
            const cpx = ((pts[k-1][0] + pts[k][0]) / 2).toFixed(1);
            d += ` C ${cpx} ${pts[k-1][1].toFixed(1)} ${cpx} ${pts[k][1].toFixed(1)} ${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)}`;
        }
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');

    const li = _aLabelIndices(n);
    const xLabelsSVG = li.filter(i => i < n).map(i =>
        `<text x="${toX(i).toFixed(1)}" y="${H-5}" text-anchor="middle" fill="rgba(240,236,228,0.35)" font-size="8" font-family="-apple-system,sans-serif">${_aDateLabel(virtueData[i].date, n)}</text>`
    ).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">
${gridSVG}${linesSVG}${xLabelsSVG}
</svg>`;
}

function makeVirtueLegendHTML() {
    return `<div class="cat-legend">${
        christLikeAttributesList.map((name, i) =>
            `<span class="cat-legend-item" style="color:${VIRTUE_LINE_COLORS[i]}">&#9679; ${name}</span>`
        ).join('')
    }</div>`;
}

// ─── Gym progression section ───────────────────────────────────────────────────

// Per-exercise progression SVG — y-axis is 0–100% of that exercise's personal best
function makeGymProgressSVG(datasets, allDates) {
    const W = 440, H = 68, PL = 32, PR = 6, PT = 6, PB = 20;
    const CW = W - PL - PR, CH = H - PT - PB;
    const n = allDates.length;
    if (!n) return _emptyChartSVG(W, H);

    // Find actual min/max across all data points, then pad by ~8% either side
    const allVals = datasets.flatMap(({ points }) => points.map(p => p.value).filter(v => v != null));
    const rawMin  = allVals.length ? Math.min(...allVals) : 0;
    const rawMax  = allVals.length ? Math.max(...allVals) : 100;
    const pad     = Math.max(5, Math.round((rawMax - rawMin) * 0.12));
    const yMin    = Math.max(0,   rawMin - pad);
    const yMax    = Math.min(100, rawMax + pad);
    const yRange  = (yMax - yMin) || 1;

    const toX = i  => PL + (i / Math.max(1, n - 1)) * CW;
    const toY = v  => PT + CH - ((v - yMin) / yRange) * CH;

    // Three evenly-spaced grid lines within the actual range
    const gridSVG = [0, 0.5, 1].map(f => {
        const val = yMin + f * yRange;
        const y   = (PT + CH * (1 - f)).toFixed(1);
        return `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>` +
            `<text x="${PL-3}" y="${(parseFloat(y)+3).toFixed(1)}" text-anchor="end" fill="rgba(240,236,228,0.38)" font-size="7" font-family="-apple-system,sans-serif">${Math.round(val)}%</text>`;
    }).join('');

    const GYM_COLORS = ['#c9a96e','#5dbea3','#7aa8d4','#a87ed4','#d47a7a','#d4c05a','#d4916a'];

    const linesSVG = datasets.map(({ points }, ci) => {
        const color = GYM_COLORS[ci % GYM_COLORS.length];
        const vps = points.map((p, i) => ({ i, v: p.value })).filter(p => p.v != null);
        if (vps.length < 2) return '';
        const pts = vps.map(p => [toX(p.i), toY(p.v)]);
        let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let k = 1; k < pts.length; k++) {
            const cpx = ((pts[k-1][0] + pts[k][0]) / 2).toFixed(1);
            d += ` C ${cpx} ${pts[k-1][1].toFixed(1)} ${cpx} ${pts[k][1].toFixed(1)} ${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)}`;
        }
        const dots = vps.map(p => `<circle cx="${toX(p.i).toFixed(1)}" cy="${toY(p.v).toFixed(1)}" r="2" fill="${color}"/>`).join('');
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    }).join('');

    const li = _aLabelIndices(n);
    const xLabelsSVG = li.filter(i => i < n).map(i =>
        `<text x="${toX(i).toFixed(1)}" y="${H-4}" text-anchor="middle" fill="rgba(240,236,228,0.35)" font-size="8" font-family="-apple-system,sans-serif">${_aDateLabel(allDates[i], n)}</text>`
    ).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="analytics-chart-svg" xmlns="http://www.w3.org/2000/svg">
${gridSVG}${linesSVG}${xLabelsSVG}
</svg>`;
}

function makeGymSection(dates) {
    const logs   = getExerciseLogs();
    const checks = getExerciseChecks();
    const dateSet = new Set(dates);

    // exVolumes[muscle][exercise][date] = volume of CHECKED sets only
    const exVolumes = {};
    Object.entries(logs).forEach(([key, sets]) => {
        const parts = key.split('__');
        if (parts.length < 3) return;
        const [date, muscle, ...exParts] = parts;
        const exercise = exParts.join('__');
        if (!dateSet.has(date)) return;

        const checkedStates = checks[key] || [];
        const volume = (Array.isArray(sets) ? sets : []).reduce((s, set, i) => {
            if (!checkedStates[i]) return s; // skip unchecked sets
            return s + (parseFloat(set.weight) || 0) * (parseFloat(set.reps) || 0);
        }, 0);
        if (!volume) return;

        if (!exVolumes[muscle]) exVolumes[muscle] = {};
        if (!exVolumes[muscle][exercise]) exVolumes[muscle][exercise] = {};
        exVolumes[muscle][exercise][date] = (exVolumes[muscle][exercise][date] || 0) + volume;
    });

    // Keep only exercises done on 2+ different days
    Object.keys(exVolumes).forEach(muscle => {
        Object.keys(exVolumes[muscle]).forEach(ex => {
            if (Object.keys(exVolumes[muscle][ex]).length < 2) delete exVolumes[muscle][ex];
        });
        if (!Object.keys(exVolumes[muscle]).length) delete exVolumes[muscle];
    });

    const muscles = Object.keys(exVolumes);
    if (!muscles.length) return null;

    const GYM_COLORS = ['#c9a96e','#5dbea3','#7aa8d4','#a87ed4','#d47a7a','#d4c05a','#d4916a'];

    const sec = document.createElement('div');
    sec.className = 'asec';
    sec.innerHTML = '<div class="asec-ttl">GYM PROGRESSION</div>';

    const select = document.createElement('select');
    select.className = 'asec-select';
    muscles.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m.toUpperCase();
        select.appendChild(opt);
    });

    const chartDiv  = document.createElement('div');
    const legendDiv = document.createElement('div');
    legendDiv.className = 'cat-legend';

    function showMuscle(muscle) {
        const exercises = exVolumes[muscle] || {};
        const exNames = Object.keys(exercises);
        if (!exNames.length) {
            chartDiv.innerHTML = _emptyChartSVG(440, 68);
            legendDiv.innerHTML = '';
            return;
        }

        // Collect all dates this muscle was trained, sorted
        const allDatesSet = new Set();
        exNames.forEach(ex => Object.keys(exercises[ex]).forEach(d => allDatesSet.add(d)));
        const allDates = Array.from(allDatesSet).sort();

        // Normalize each exercise to % of its personal best
        const datasets = exNames.map((ex, i) => {
            const dateVols = exercises[ex];
            const best = Math.max(...Object.values(dateVols));
            return {
                name: ex,
                color: GYM_COLORS[i % GYM_COLORS.length],
                points: allDates.map(d => ({
                    date: d,
                    value: dateVols[d] != null ? Math.round((dateVols[d] / best) * 100) : null
                }))
            };
        });

        chartDiv.innerHTML = makeGymProgressSVG(datasets, allDates);
        legendDiv.innerHTML = datasets.map(({ name, color }) =>
            `<span class="cat-legend-item" style="color:${color}">&#9679; ${name}</span>`
        ).join('');
    }

    select.addEventListener('change', () => showMuscle(select.value));
    showMuscle(muscles[0]);
    sec.appendChild(select);
    sec.appendChild(chartDiv);
    sec.appendChild(legendDiv);
    return sec;
}

// ─── Reflection viewer ─────────────────────────────────────────────────────────

const RF_QUESTIONS = [
    { key: 'happy',    label: 'What made me happy today?'         },
    { key: 'grateful', label: 'What am I grateful for today?'     },
    { key: 'learned',  label: 'What did I learn today?'           },
    { key: 'helped',   label: 'How did I help someone else today?' },
    { key: 'better',   label: 'What will I do better tomorrow?'   },
];

function _rfDateLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m-1]} ${d}, ${y}`;
}

function _rfRenderList(list, entries) {
    list.innerHTML = '';
    if (!entries.length) {
        list.innerHTML = '<div class="rf-empty">no entries for this period</div>';
        return;
    }
    entries.forEach(({ date, title, text }) => {
        const item = document.createElement('div');
        item.className = 'rf-response-item';
        item.innerHTML = `<div class="rf-item-date">${_rfDateLabel(date)}${title ? ' — ' + title : ''}</div><div class="rf-item-text">${text}</div>`;
        list.appendChild(item);
    });
}

function makeReflectionSection(dates) {
    const sec = document.createElement('div');
    sec.className = 'asec';

    // Single dropdown: reflection questions as an optgroup, then the other three
    const select = document.createElement('select');
    select.className = 'asec-select';

    const rfGroup = document.createElement('optgroup');
    rfGroup.label = 'REFLECTION';
    RF_QUESTIONS.forEach(q => {
        const opt = document.createElement('option');
        opt.value = 'rf__' + q.key;
        opt.textContent = q.label;
        rfGroup.appendChild(opt);
    });
    select.appendChild(rfGroup);

    const otherGroup = document.createElement('optgroup');
    otherGroup.label = 'NOTES';
    [
        { value: 'spiritual',  label: 'Spiritual'  },
        { value: 'mindset',    label: 'Mindset'    },
        { value: 'creativity', label: 'Creativity' },
    ].forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = label;
        otherGroup.appendChild(opt);
    });
    select.appendChild(otherGroup);

    const list = document.createElement('div');
    list.className = 'rf-response-list';

    function showSelection(val) {
        list.innerHTML = '';

        if (val.startsWith('rf__')) {
            const key = val.slice(4);
            const allData = JSON.parse(Storage.getItem('reflection_321') || '{}');
            const entries = [];
            dates.forEach(date => {
                const day = allData[date] || {};
                (day[key] || []).filter(e => e && e.trim()).forEach(text => {
                    entries.push({ date, text });
                });
            });
            _rfRenderList(list, entries.reverse());
            return;
        }
        if (val === 'spiritual') {
            const all = JSON.parse(Storage.getItem(SPIRITUAL_KEY) || '{}');
            const entries = [];
            dates.forEach(date => {
                (all[date] || []).forEach(e => {
                    if (e.notes && e.notes.trim())
                        entries.push({ date, title: e.topic || '', text: e.notes });
                });
            });
            _rfRenderList(list, entries.reverse());
            return;
        }
        if (val === 'mindset') {
            const notes = getMindsetNotes();
            const entries = [];
            Object.entries(notes).forEach(([key, text]) => {
                if (!text || !text.trim()) return;
                const sep   = key.indexOf('__');
                const type  = sep >= 0 ? key.slice(0, sep)  : key;
                const title = sep >= 0 ? key.slice(sep + 2) : key;
                entries.push({ date: '', title: `${type.toUpperCase()}: ${title}`, text });
            });
            if (!entries.length) {
                list.innerHTML = '<div class="rf-empty">no mindset notes yet</div>';
            } else {
                entries.forEach(({ title, text }) => {
                    const item = document.createElement('div');
                    item.className = 'rf-response-item';
                    item.innerHTML = `<div class="rf-item-date">${title}</div><div class="rf-item-text">${text}</div>`;
                    list.appendChild(item);
                });
            }
            return;
        }
        if (val === 'creativity') {
            const notes   = getCreativityNotes();
            const dateSet = new Set(dates);
            const entries = [];
            Object.entries(notes).forEach(([key, text]) => {
                if (!text || !text.trim()) return;
                const sep  = key.indexOf('__');
                const date = sep >= 0 ? key.slice(0, sep) : '';
                const item = sep >= 0 ? key.slice(sep + 2) : key;
                if (!dateSet.has(date)) return;
                entries.push({ date, title: item, text });
            });
            _rfRenderList(list, entries.sort((a, b) => b.date.localeCompare(a.date)));
        }
    }

    select.addEventListener('change', () => showSelection(select.value));
    showSelection(select.value);
    sec.appendChild(select);
    sec.appendChild(list);
    return sec;
}

// ─── Render orchestrator ───────────────────────────────────────────────────────

function _aAppendSec(parent, title, html) {
    const sec = document.createElement('div');
    sec.className = 'asec';
    sec.innerHTML = `<div class="asec-ttl">${title}</div>${html}`;
    parent.appendChild(sec);
    return sec;
}

function renderAnalytics(period) {
    const dates    = getAnalyticsDates(period);
    const body     = document.getElementById('analytics-body');
    if (!body) return;
    body.innerHTML = '';

    const scoreData  = analyticsScoreData(dates);
    const wData      = analyticsWeightData(dates);
    const sleepData  = analyticsSleepData(dates);
    const hydroData  = analyticsHydrationData(dates);
    const calData    = analyticsCalorieData(dates);
    const mfData     = analyticsMindfulnessData(dates);
    const prayerData = analyticsPrayerData(dates);
    const recStats   = analyticsRecoveryStats(dates);

    // Category averages
    const catTotals = {}, catCounts = {};
    defaultValues.forEach(d => { catTotals[d.name] = 0; catCounts[d.name] = 0; });
    scoreData.forEach(d => {
        defaultValues.forEach(def => {
            const v = d.byCategory[def.name];
            if (v > 0) { catTotals[def.name] += v; catCounts[def.name]++; }
        });
    });
    const catAvgs = {};
    defaultValues.forEach(def => {
        catAvgs[def.name] = catCounts[def.name] ? catTotals[def.name] / catCounts[def.name] : 0;
    });

    const GOLD = '#c9a96e';
    const showDots = dates.length <= 31;

    // Three-column wrapper
    const cols = document.createElement('div');
    cols.className = 'analytics-cols';
    const col1 = document.createElement('div');
    col1.className = 'analytics-col';
    const col2 = document.createElement('div');
    col2.className = 'analytics-col';
    const col3 = document.createElement('div');
    col3.className = 'analytics-col';
    cols.appendChild(col1);
    cols.appendChild(col2);
    cols.appendChild(col3);
    body.appendChild(cols);

    // ── COLUMN 1 ──────────────────────────────────────────────────────────────
    // pos 1: Gym Volume

    const gymSec = makeGymSection(dates);
    if (gymSec) col1.appendChild(gymSec);

    // pos 4: Sin Levels
    const sinTrendSec = document.createElement('div');
    sinTrendSec.className = 'asec';
    sinTrendSec.innerHTML = `<div class="asec-ttl">SIN LEVELS</div>` +
        makeSinTrendSVG(analyticsSinData(dates)) + makeSinLegendHTML();
    col1.appendChild(sinTrendSec);

    // pos 7, 10
    _aAppendSec(col1, 'CALORIES',
        makeLineSVG(calData.map(d => ({ date: d.date, value: d.cal })), GOLD, { min: 0, showDots })
    );
    _aAppendSec(col1, 'WATER (CUPS)',
        makeLineSVG(hydroData, GOLD, { min: 0, maxVal: 15, showDots })
    );

    // ── COLUMN 2 ──────────────────────────────────────────────────────────────
    // pos 2, 5
    _aAppendSec(col2, 'MINDFULNESS (MIN)',
        makeLineSVG(mfData, GOLD, { min: 0, maxVal: 30, showDots })
    );
    _aAppendSec(col2, 'SLEEP (HRS)',
        makeLineSVG(sleepData, GOLD, { min: 6, maxVal: 10, targetLine: 8, showDots })
    );

    // pos 8: Virtue Levels
    const virtueTrendSec = document.createElement('div');
    virtueTrendSec.className = 'asec';
    virtueTrendSec.innerHTML = `<div class="asec-ttl">VIRTUE LEVELS</div>` +
        makeVirtueTrendSVG(analyticsVirtueData(dates)) + makeVirtueLegendHTML();
    col2.appendChild(virtueTrendSec);

    // pos 11
    _aAppendSec(col2, 'BODY WEIGHT (LBS)',
        makeLineSVG(wData, GOLD, { min: 150, maxVal: 180, showDots })
    );

    // ── COLUMN 3 ──────────────────────────────────────────────────────────────
    // pos 3: Category Trends
    const catTrendSec = document.createElement('div');
    catTrendSec.className = 'asec';
    catTrendSec.innerHTML = `<div class="asec-ttl">CATEGORY TRENDS</div>` +
        makeCategoryTrendSVG(scoreData) + makeCatLegendHTML();
    col3.appendChild(catTrendSec);

    // pos 6: Reflection
    col3.appendChild(makeReflectionSection(dates));

}

// ─── Open / Close ──────────────────────────────────────────────────────────────

function openAnalytics() {
    const modal = document.getElementById('analyticsModal');
    if (!modal) return;
    modal.style.display = 'flex';
    renderAnalytics(_analyticsPeriod);
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('a-open')));
}

function closeAnalytics() {
    const modal = document.getElementById('analyticsModal');
    if (!modal) return;
    modal.classList.remove('a-open');
    setTimeout(() => {
        if (!modal.classList.contains('a-open')) modal.style.display = 'none';
    }, 300);
}

document.getElementById('analyticsTabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-period]');
    if (!tab) return;
    document.querySelectorAll('.atab').forEach(t => t.classList.remove('atab--active'));
    tab.classList.add('atab--active');
    _analyticsPeriod = tab.dataset.period;
    renderAnalytics(_analyticsPeriod);
});

document.getElementById('closeAnalytics').addEventListener('click', closeAnalytics);

document.addEventListener('keydown', e => {
    const modal = document.getElementById('analyticsModal');
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') closeAnalytics();
});

