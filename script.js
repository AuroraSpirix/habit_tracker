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
const defaultValues = [
    { name: 'Spirituality', value: 5, note: '' },
    { name: 'Mobility', value: 5, note: '' },
    { name: 'Mindset', value: 5, note: '' },
    { name: 'Reflection', value: 5, note: '' },
    { name: 'Recovery', value: 5, note: '' },
    { name: 'Mindfulness', value: 5, note: '' }
];

const avoidedActivitiesList = ['Lusted', 'Angered', 'Avoided', 'Neglected', 'Doubted'];
let avoidedToday = [];


function getDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function loadDayData() {
    const key = getDateKey(viewDate);
    const savedData = localStorage.getItem(STORAGE_KEY);
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
        return {
            name: def.name,
            value: saved.value !== undefined ? saved.value : def.value,
            note: saved.note !== undefined ? saved.note : def.note
        };
    });

    updateDateDisplay();
    initChart();
    renderAvoidedButtons();
}

function saveDayData() {
    const key = getDateKey(viewDate);
    const savedData = localStorage.getItem(STORAGE_KEY);
    const allData = savedData ? JSON.parse(savedData) : {};

    allData[key] = {
        vitals: categories,
        avoided: avoidedToday
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allData));
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


        const labelDistance = maxValue + 3;
        const labelPos = getCoords(i, labelDistance);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", labelPos.x);
        text.setAttribute("y", labelPos.y);


        let hasNote = false;
        if (cat.name === 'Spirituality') {
            const all = JSON.parse(localStorage.getItem(SPIRITUAL_KEY) || '{}');
            const entries = all[getDateKey(viewDate)] || [];
            hasNote = entries.some(e => e.topic || e.notes);
        }
        else if (['Mindfulness', 'Recovery', 'Reflection'].includes(cat.name)) {
            const all = JSON.parse(localStorage.getItem('journal_entries__' + cat.name.toLowerCase()) || '{}');
            const entries = all[getDateKey(viewDate)] || [];
            hasNote = entries.some(e => e.topic || e.notes);
        }
        else if (cat.name === 'Mindset') {
            const all = JSON.parse(localStorage.getItem('mindset_notes') || '{}');
            const datePrefix = getDateKey(viewDate) + '__';
            hasNote = Object.keys(all).some(k => k.startsWith(datePrefix) && all[k].trim() !== '');
        }
        else if (cat.name === 'Mobility') {
            const datePrefix = getDateKey(viewDate) + '__';

            const logs = JSON.parse(localStorage.getItem('exercise_logs') || '{}');
            const hasLifts = Object.keys(logs).some(k =>
                k.startsWith(datePrefix) && logs[k].some(s => s.weight || s.reps)
            );

            const simpleNotes = JSON.parse(localStorage.getItem('mobility_simple_notes') || '{}');
            const hasSimple = Object.keys(simpleNotes).some(k =>
                k.startsWith(datePrefix) && simpleNotes[k].trim() !== ''
            );
            hasNote = hasLifts || hasSimple;
        }


        text.setAttribute("class", hasNote ? "axis-label has-note" : "axis-label");

        text.textContent = cat.name.toUpperCase();
        text.onclick = () => openNoteModal(i);

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

        hitbox.addEventListener('mousedown', (e) => startDrag(e, i));
        hitbox.addEventListener('touchstart', (e) => startDrag(e, i), {passive: false});

        group.appendChild(hitbox);
        group.appendChild(visualDot);
        group.appendChild(labelText);
        svg.appendChild(group);
    });


}

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
    _dragStartX = e.touches ? e.touches[0].clientX : e.clientX;
    _dragStartY = e.touches ? e.touches[0].clientY : e.clientY;
    _dragMoved = false;
    document.body.style.cursor = 'grabbing';
    window.addEventListener('mousemove', drag, {passive: false});
    window.addEventListener('mouseup', stopDrag);
    window.addEventListener('touchmove', drag, {passive: false});
    window.addEventListener('touchend', stopDrag);
}

let _dragStartX = 0, _dragStartY = 0, _dragMoved = false;

function drag(e) {
    if (currentHandleIdx === null) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    // Only start dragging after a small movement threshold (avoids misfire on tap)
    if (!_dragMoved) {
        const dist = Math.sqrt(Math.pow(clientX - _dragStartX, 2) + Math.pow(clientY - _dragStartY, 2));
        if (dist < 4) return;
        _dragMoved = true;
        isDragging = true;
    }

    const rect = svg.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * 400;
    const svgY = ((clientY - rect.top) / rect.height) * 400;

    const angle = (Math.PI * 2 / categories.length) * currentHandleIdx - Math.PI / 2;
    const dx = svgX - centerX;
    const dy = svgY - centerY;

    const projectedDist = dx * Math.cos(angle) + dy * Math.sin(angle);
    let newValue = (projectedDist / radius) * maxValue;

    categories[currentHandleIdx].value = Math.min(Math.max(Math.round(newValue), 0), maxValue);

    render();
    saveDayData();
}

function stopDrag(e) {
    // If barely moved, treat as a tap → increment value (wraps 0→10→0)
    if (!_dragMoved && currentHandleIdx !== null) {
        const cat = categories[currentHandleIdx];
        cat.value = cat.value >= maxValue ? 0 : cat.value + 1;
        render();
        saveDayData();
    }
    isDragging = false;
    _dragMoved = false;
    currentHandleIdx = null;
    document.body.style.cursor = 'default';
    window.removeEventListener('mousemove', drag);
    window.removeEventListener('mouseup', stopDrag);
    window.removeEventListener('touchmove', drag);
    window.removeEventListener('touchend', stopDrag);
}


document.getElementById('prevDay').addEventListener('click', () => {
    viewDate.setDate(viewDate.getDate() - 1);
    loadDayData();
});

document.getElementById('nextDay').addEventListener('click', () => {
    viewDate.setDate(viewDate.getDate() + 1);
    loadDayData();
});


loadDayData();


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


        initChart();

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

function renderAvoidedButtons() {
    const container = document.getElementById('avoided-buttons');
    if (!container) return;
    container.innerHTML = '';

    avoidedActivitiesList.forEach(activity => {
        const btn = document.createElement('button');
        btn.className = 'avoid-btn';


        if (avoidedToday.includes(activity)) {
            btn.classList.add('active');
        }

        btn.textContent = activity;
        btn.onclick = () => toggleAvoided(activity);
        container.appendChild(btn);
    });
}

function toggleAvoided(activity) {
    if (avoidedToday.includes(activity)) {

        avoidedToday = avoidedToday.filter(item => item !== activity);
    } else {

        avoidedToday.push(activity);
    }
    saveDayData();
    renderAvoidedButtons();
}

const EXERCISE_LIBRARY_KEY = 'exercise_library';
const EXERCISE_LOGS_KEY = 'exercise_logs';

const muscleGroups = ['Triceps', 'Biceps', 'Shoulders', 'Chest', 'Back', 'Abs'];
let activeMuscle = null;
let activeExercise = null;


function getMasterLibrary() {
    const raw = localStorage.getItem(EXERCISE_LIBRARY_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveMasterLibrary(lib) {
    localStorage.setItem(EXERCISE_LIBRARY_KEY, JSON.stringify(lib));
}


function getDayLibraryKey(date) {
    return `exercise_library__${getDateKey(date)}`;
}
function getExerciseLibrary() {
    const dayKey = getDayLibraryKey(viewDate);
    const dayRaw = localStorage.getItem(dayKey);
    if (dayRaw) {
        return JSON.parse(dayRaw);
    }

    const master = getMasterLibrary();
    localStorage.setItem(dayKey, JSON.stringify(master));
    return master;
}
function saveExerciseLibrary(lib) {

    localStorage.setItem(getDayLibraryKey(viewDate), JSON.stringify(lib));
}
function getExerciseLogs() {
    const raw = localStorage.getItem(EXERCISE_LOGS_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveExerciseLogs(logs) {
    localStorage.setItem(EXERCISE_LOGS_KEY, JSON.stringify(logs));
}
function getDayLogKey(muscle, exercise) {
    return `${getDateKey(viewDate)}__${muscle}__${exercise}`;
}


function showExScreen(id) {
    ['ex-screen-muscles','ex-screen-exercises','ex-screen-sets','ex-screen-simple'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

const MOBILITY_EXTRAS = ['Yoga', 'Posture'];
const MOBILITY_SIMPLE_KEY = 'mobility_simple_notes';

function getMobilitySimpleNotes() {
    const raw = localStorage.getItem(MOBILITY_SIMPLE_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveMobilitySimpleNotes(notes) {
    localStorage.setItem(MOBILITY_SIMPLE_KEY, JSON.stringify(notes));
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
    const logs = getExerciseLogs();
    const datePrefix = getDateKey(viewDate) + '__';

    muscleGroups.forEach(muscle => {
        const btn = document.createElement('button');
        btn.className = 'muscle-btn';
        const hasData = Object.keys(logs).some(k =>
            k.startsWith(datePrefix + muscle + '__') &&
            logs[k].some(s => (s.weight && s.weight !== '0') || (s.reps && s.reps !== '0'))
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
        if (simpleNotes[noteKey] && simpleNotes[noteKey].trim()) btn.classList.add('has-data');
        btn.textContent = type.toUpperCase();
        btn.onclick = () => openSimpleScreen(type);
        extras.appendChild(btn);
    });
}

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
    initChart();
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
    const datePrefix = getDateKey(viewDate) + '__';

    if (exercises.length === 0) {
        list.innerHTML = '<p class="empty-state">No exercises yet. Add one below.</p>';
        return;
    }

    exercises.forEach(ex => {
        const logKey = getDayLogKey(activeMuscle, ex);
        const sets = logs[logKey];
        const hasData = sets && sets.some(s => s.weight || s.reps);

        const row = document.createElement('div');
        row.className = hasData ? 'exercise-row has-data' : 'exercise-row';

        const name = document.createElement('span');
        name.className = 'exercise-row-name';
        name.textContent = ex;

        const meta = document.createElement('span');
        meta.className = 'exercise-row-meta';
        if (hasData) {
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
        row.onclick = () => openSetsScreen(ex);
        list.appendChild(row);
    });
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
    initChart();
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
    document.getElementById('ex-exercise-title').textContent = exercise.toUpperCase();
    renderSets();
    showExScreen('ex-screen-sets');
}

function renderSets() {
    const container = document.getElementById('sets-list');
    container.innerHTML = '';
    const logs = getExerciseLogs();
    const logKey = getDayLogKey(activeMuscle, activeExercise);
    const saved = logs[logKey] || [{weight:'',reps:''},{weight:'',reps:''},{weight:'',reps:''}];


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
        label.textContent = `SET ${i + 1}`;

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
    initChart();
    renderExerciseList();
    showExScreen('ex-screen-exercises');
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
    const raw = localStorage.getItem(SPIRITUAL_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] || [];
}

function saveSpiritualEntries(entries) {
    const raw = localStorage.getItem(SPIRITUAL_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = entries;
    localStorage.setItem(SPIRITUAL_KEY, JSON.stringify(all));
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
        topic.textContent = entry.topic || 'UNTITLED';

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

            initChart();
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
    initChart();
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
    const raw = localStorage.getItem(JOURNAL_CONFIGS[type].key);
    const all = raw ? JSON.parse(raw) : {};
    return all[getDateKey(viewDate)] || [];
}
function saveJournalEntries(type, entries) {
    const raw = localStorage.getItem(JOURNAL_CONFIGS[type].key);
    const all = raw ? JSON.parse(raw) : {};
    all[getDateKey(viewDate)] = entries;
    localStorage.setItem(JOURNAL_CONFIGS[type].key, JSON.stringify(all));
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
        topic.textContent = entry.topic || 'UNTITLED';

        const del = document.createElement('button');
        del.className = 'exercise-delete-btn';
        del.textContent = '×';
        del.onclick = (e) => {
            e.stopPropagation();
            const entries = getJournalEntries(type);
            entries.splice(idx, 1);
            saveJournalEntries(type, entries);
            renderJournalList(type);
            initChart();
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
        initChart();
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
    const raw = localStorage.getItem('mindset_library__' + type);
    return raw ? JSON.parse(raw) : [];
}
function saveMindsetLibraryForType(type, lib) {
    localStorage.setItem('mindset_library__' + type, JSON.stringify(lib));
}
function getMindsetNotes() {
    const raw = localStorage.getItem(MINDSET_NOTES_KEY);
    return raw ? JSON.parse(raw) : {};
}
function saveMindsetNotes(notes) {
    localStorage.setItem(MINDSET_NOTES_KEY, JSON.stringify(notes));
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
            initChart();
        };

        row.appendChild(title);
        row.appendChild(del);
        row.onclick = () => openBookNotes(item);
        list.appendChild(row);
    });
}

function openBookNotes(item) {
    activeBook = item;
    document.getElementById('ms-book-title').textContent = item.toUpperCase();
    const notes = getMindsetNotes();
    document.getElementById('msBookNotes').value = notes[getMindsetNoteKey(activeMindsetType, item)] || '';
    showMsScreen('ms-screen-notes');
    setTimeout(() => document.getElementById('msBookNotes').focus(), 50);
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
    initChart();
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

const AVOIDED_ENTRIES_KEY = 'avoided_entries';
let activeAvoidedActivity = null;

function getAvoidedEntries() {
    try { return JSON.parse(localStorage.getItem(AVOIDED_ENTRIES_KEY)) || {}; }
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
    document.getElementById('avoidedWhatHappened').value = entry ? entry.happened : '';
    document.getElementById('avoidedWhatLearned').value = entry ? entry.learned : '';
    document.getElementById('avoidedModal').style.display = 'flex';
    setTimeout(() => document.getElementById('avoidedWhatHappened').focus(), 50);
}

function closeAvoidedModal() {
    document.getElementById('avoidedModal').style.display = 'none';
    activeAvoidedActivity = null;
}

document.getElementById('avoidedSaveBtn').addEventListener('click', function() {
    const happened = document.getElementById('avoidedWhatHappened').value.trim();
    const learned = document.getElementById('avoidedWhatLearned').value.trim();
    const key = getDateKey(viewDate) + '__' + activeAvoidedActivity;
    const all = getAvoidedEntries();

    if (happened || learned) {
        all[key] = { happened, learned };
        if (!avoidedToday.includes(activeAvoidedActivity)) {
            avoidedToday.push(activeAvoidedActivity);
        }
    } else {
        delete all[key];
        avoidedToday = avoidedToday.filter(a => a !== activeAvoidedActivity);
    }

    localStorage.setItem(AVOIDED_ENTRIES_KEY, JSON.stringify(all));
    saveDayData();
    renderAvoidedButtons();
    closeAvoidedModal();
});

document.getElementById('closeAvoidedModal').addEventListener('click', closeAvoidedModal);


(function() {
    const original = renderAvoidedButtons;
    window.renderAvoidedButtons = function() {
        const container = document.getElementById('avoided-buttons');
        if (!container) return;
        container.innerHTML = '';
        avoidedActivitiesList.forEach(activity => {
            const btn = document.createElement('button');
            btn.className = 'avoid-btn';
            const entry = getAvoidedEntry(activity);
            if (avoidedToday.includes(activity) || entry) btn.classList.add('active');
            btn.textContent = activity;
            btn.onclick = () => openAvoidedModal(activity);
            container.appendChild(btn);
        });
    };
    renderAvoidedButtons();
})();


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
    try { return JSON.parse(localStorage.getItem(GRATITUDE_KEY)) || {}; }
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
    localStorage.setItem(GRATITUDE_KEY, JSON.stringify(entries));
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