const STORAGE_KEY = 'pokerStackTracker';
const SOLO_BACKUP_KEY = 'pokerStackTracker_soloBackup';
const KNOWN_ROLES = ['host', 'editor', 'viewer'];

// Room session bookkeeping
let pendingSoloStash = false;
let lastEditable = null;
// Last non-null room status so leave-after-ended can keep final stacks.
let lastRoomStatus = null;

const HOUSE_DEALER_ID = 'house-dealer';
const HOUSE_HOST_ID = 'house-host';
const RAKE_TYPES = ['none', 'time', 'pot', 'flat', 'custom'];

// Game state
let gameState = {
    blindStructure: { small: 1, big: 2 },
    stackAmount: 200,
    players: [],
    darkMode: true,
    compactMode: true,
    sessionName: 'Session Name',
    bankerName: 'Banker',
    rake: {
        enabled: false,
        type: 'none',
        perPlayerPerHour: 5,
        percent: 5,
        cap: 5,
        perPlayer: 10,
        note: ''
    },
    house: [
        { id: HOUSE_DEALER_ID, kind: 'dealer', name: 'Dealer', cashOut: 0 },
        { id: HOUSE_HOST_ID, kind: 'host', name: 'Host', cashOut: 0 }
    ],
    clock: {
        running: false,
        startedAt: null,
        elapsedMs: 0
    }
};

let undoStack = [];
let clockTimer = null;
let editingHouseId = null;
let roomUiReady = false;
let appUnlocked = false;

// DOM Elements
const addPlayerBtn = document.getElementById('addPlayerBtn');
const stackAmountInput = document.getElementById('stackAmount');
const clearStatsBtn = document.getElementById('clearStatsBtn');
const exportBtn = document.getElementById('exportBtn');
const themeToggle = document.getElementById('themeToggle');
const fontSizeToggle = document.getElementById('fontSizeToggle');
const deletePlayerBtn = document.getElementById('deletePlayerBtn');
const blindDisplay = document.getElementById('blindDisplay');
const totalBalanceDisplay = document.getElementById('totalBalance');
const playerTableBody = document.getElementById('playerTableBody');
const totalPlayersDisplay = document.getElementById('totalPlayers');

// Modals
const blindModal = document.getElementById('blindModal');
const playerModal = document.getElementById('playerModal');
const editNameModal = document.getElementById('editNameModal');
const blindForm = document.getElementById('blindForm');
const playerForm = document.getElementById('playerForm');
const editNameForm = document.getElementById('editNameForm');
const editSessionModal = document.getElementById('editSessionModal');
const editSessionForm = document.getElementById('editSessionForm');

// Store current player being edited
let editingPlayerId = null;

// Initialize
loadGameState();
applyTheme();
applyFontSize();
bootApp().catch((e) => console.error('bootApp', e));

// Close buttons
const closeButtons = document.querySelectorAll('.close');

// Event Listeners
// Function to open blind modal (called from HTML onclick)
function openBlindModal() {
    if (!assertCanEdit()) return;
    blindModal.style.display = 'block';
}

// Make function globally accessible
window.openBlindModal = openBlindModal;

addPlayerBtn.addEventListener('click', () => {
    if (!assertCanEdit()) return;
    document.getElementById('playerBuyIn').value = gameState.stackAmount;
    renderSeatFromRoom();
    playerModal.style.display = 'block';
});

stackAmountInput.addEventListener('change', (e) => {
    if (!assertCanEdit()) {
        stackAmountInput.value = gameState.stackAmount;
        return;
    }
    gameState.stackAmount = parseFloat(e.target.value) || 200;
    saveGameState();
});

themeToggle.addEventListener('click', () => {
    gameState.darkMode = !gameState.darkMode;
    saveGameState();
    applyTheme();
});

fontSizeToggle.addEventListener('click', () => {
    gameState.compactMode = !gameState.compactMode;
    saveGameState();
    applyFontSize();
});

clearStatsBtn.addEventListener('click', () => {
    if (!assertCanEdit()) return;
    if (confirm('Are you sure you want to clear all stats? This cannot be undone.')) {
        gameState.players = [];
        gameState.sessionName = 'Session Name';
        gameState.bankerName = 'Banker';
        ensureHouseState();
        gameState.house.forEach((row) => { row.cashOut = 0; });
        pauseClock(true);
        gameState.clock = defaultClock();
        undoStack = [];
        saveGameState();
        updateDisplay();
    }
});

exportBtn.addEventListener('click', () => {
    exportToExcel();
});

blindForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!assertCanEdit()) return;
    const smallBlind = parseFloat(document.getElementById('smallBlind').value);
    const bigBlind = parseFloat(document.getElementById('bigBlind').value);

    gameState.blindStructure = { small: smallBlind, big: bigBlind };
    saveGameState();
    updateBlindDisplay();
    blindModal.style.display = 'none';
    blindForm.reset();
});

playerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!assertCanEdit()) return;
    const name = document.getElementById('playerName').value.trim();
    const buyIn = parseFloat(document.getElementById('playerBuyIn').value);

    if (name && buyIn >= 0) {
        addPlayer(name, buyIn);
        playerModal.style.display = 'none';
        playerForm.reset();
    }
});

editNameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!assertCanEdit()) return;
    const newName = document.getElementById('editPlayerName').value.trim();

    if (newName && editingHouseId) {
        updateHouseName(editingHouseId, newName);
        closeEditNameModal();
        return;
    }

    if (newName && editingPlayerId) {
        updatePlayerName(editingPlayerId, newName);
        closeEditNameModal();
    }
});

deletePlayerBtn.addEventListener('click', () => {
    if (!assertCanEdit()) return;
    if (editingHouseId) return;
    if (editingPlayerId && confirm('Are you sure you want to delete this player? This cannot be undone.')) {
        deletePlayer(editingPlayerId);
        closeEditNameModal();
    }
});

// Session Name Modal
editSessionForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!assertCanEdit()) return;
    const newName = document.getElementById('editSessionName').value.trim();

    if (newName) {
        gameState.sessionName = newName;
    } else {
        gameState.sessionName = 'Session Name';
    }

    updateSessionNameDisplay();
    saveGameState();
    editSessionModal.style.display = 'none';
    editSessionForm.reset();
});

// Banker Modal - using setTimeout to ensure DOM is ready
setTimeout(() => {
    const form = document.getElementById('editBankerForm');
    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!assertCanEdit()) return;
            const select = document.getElementById('bankerSelect');
            const customInput = document.getElementById('editBankerName');

            let bankerName = '';
            if (select.value === 'custom') {
                bankerName = customInput.value.trim();
            } else {
                bankerName = select.value;
            }

            if (bankerName) {
                gameState.bankerName = `Banker: ${bankerName}`;
            } else {
                gameState.bankerName = 'Banker';
            }

            updateBankerNameDisplay();
            saveGameState();

            const modal = document.getElementById('editBankerModal');
            if (modal) modal.style.display = 'none';

            // Reset form
            form.reset();
            const customGroup = document.getElementById('customBankerGroup');
            if (customGroup) customGroup.style.display = 'none';
        });
    }
}, 100);

closeButtons.forEach(btn => {
    btn.addEventListener('click', function() {
        this.closest('.modal').style.display = 'none';
    });
});

// Close modal when clicking outside
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.style.display = 'none';
    }
});

const rakeForm = document.getElementById('rakeForm');
if (rakeForm) {
    rakeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!assertCanEdit()) return;
        gameState.rake = readRakeFields('', document.getElementById('rakeModal'));
        saveGameState();
        updateRakeDisplay();
        updateDisplay();
        rakeModalHide();
    });
}

document.querySelectorAll('input[name="rakeEnabled"]').forEach((el) => {
    el.addEventListener('change', () => syncRakeFieldVisibility(document.getElementById('rakeModal')));
});
const rakeTypeSelect = document.getElementById('rakeType');
if (rakeTypeSelect) {
    rakeTypeSelect.addEventListener('change', () => syncRakeFieldVisibility(document.getElementById('rakeModal')));
}

document.querySelectorAll('input[name="roomRakeEnabled"]').forEach((el) => {
    el.addEventListener('change', () => syncRakeFieldVisibility(document.getElementById('roomRakeGroup')));
});
const roomRakeType = document.getElementById('roomRakeType');
if (roomRakeType) {
    roomRakeType.addEventListener('change', () => syncRakeFieldVisibility(document.getElementById('roomRakeGroup')));
}

document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        if (!assertCanEdit()) return;
        const small = parseFloat(btn.dataset.small);
        const big = parseFloat(btn.dataset.big);
        const stack = parseFloat(btn.dataset.stack);
        document.getElementById('smallBlind').value = String(small);
        document.getElementById('bigBlind').value = String(big);
        gameState.blindStructure = { small, big };
        gameState.stackAmount = stack;
        saveGameState();
        updateDisplay();
        if (blindModal) blindModal.style.display = 'none';
    });
});

const undoBtn = document.getElementById('undoBtn');
if (undoBtn) {
    undoBtn.addEventListener('click', () => undoLastStack());
}

const sessionClockBtn = document.getElementById('sessionClockBtn');
if (sessionClockBtn) {
    sessionClockBtn.addEventListener('click', () => toggleClock());
}

const sessionClockResetBtn = document.getElementById('sessionClockResetBtn');
if (sessionClockResetBtn) {
    sessionClockResetBtn.addEventListener('click', () => resetClock());
}

// Functions
function money(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function formatMoney(n, withSign) {
    const v = money(n);
    const abs = Math.abs(v).toFixed(2);
    if (withSign) {
        if (v > 0) return `+$${abs}`;
        if (v < 0) return `-$${abs}`;
    }
    return `$${abs}`;
}

function defaultRake() {
    return {
        enabled: false,
        type: 'none',
        perPlayerPerHour: 5,
        percent: 5,
        cap: 5,
        perPlayer: 10,
        note: ''
    };
}

function defaultHouse() {
    return [
        { id: HOUSE_DEALER_ID, kind: 'dealer', name: 'Dealer', cashOut: 0 },
        { id: HOUSE_HOST_ID, kind: 'host', name: 'Host', cashOut: 0 }
    ];
}

function defaultClock() {
    return { running: false, startedAt: null, elapsedMs: 0 };
}

function normalizeRake(raw) {
    const base = defaultRake();
    if (!raw || typeof raw !== 'object') return base;
    const type = RAKE_TYPES.includes(raw.type) ? raw.type : 'none';
    const enabled = raw.enabled === true && type !== 'none';
    return {
        enabled,
        type: enabled ? type : (type === 'none' ? 'none' : type),
        perPlayerPerHour: Math.max(0, toNumber(raw.perPlayerPerHour, base.perPlayerPerHour)),
        percent: Math.max(0, toNumber(raw.percent, base.percent)),
        cap: Math.max(0, toNumber(raw.cap, base.cap)),
        perPlayer: Math.max(0, toNumber(raw.perPlayer, base.perPlayer)),
        note: String(raw.note || '').slice(0, 80)
    };
}

function normalizeHouse(raw) {
    const defaults = defaultHouse();
    const list = Array.isArray(raw) ? raw : [];
    return defaults.map((def) => {
        const found = list.find((h) => h && (h.id === def.id || h.kind === def.kind));
        const name = String((found && found.name) || def.name).trim() || def.name;
        return {
            id: def.id,
            kind: def.kind,
            name,
            cashOut: Math.max(0, money(found && found.cashOut))
        };
    });
}

function normalizeClock(raw) {
    const base = defaultClock();
    if (!raw || typeof raw !== 'object') return base;
    const running = raw.running === true;
    const startedAt = running && raw.startedAt != null ? toNumber(raw.startedAt, null) : null;
    return {
        running,
        startedAt,
        elapsedMs: Math.max(0, toNumber(raw.elapsedMs, 0))
    };
}

function ensureHouseState() {
    gameState.rake = normalizeRake(gameState.rake);
    gameState.house = normalizeHouse(gameState.house);
    gameState.clock = normalizeClock(gameState.clock);
}

function seatedPlayers() {
    return Array.isArray(gameState.players) ? gameState.players : [];
}

function closeEditNameModal() {
    editNameModal.style.display = 'none';
    editNameForm.reset();
    editingPlayerId = null;
    editingHouseId = null;
    if (deletePlayerBtn) deletePlayerBtn.style.display = '';
}

function rakeModalHide() {
    const modal = document.getElementById('rakeModal');
    if (modal) modal.style.display = 'none';
}

function isRakeOn(scope) {
    const checked = scope && scope.querySelector('input[name="rakeEnabled"]:checked, input[name="roomRakeEnabled"]:checked');
    return !!(checked && checked.value === 'yes');
}

function syncRakeFieldVisibility(scope) {
    if (!scope) return;
    const enabled = isRakeOn(scope);
    const details = scope.querySelector('.rake-details, #rakeStructureFields, #roomRakeDetails');
    if (details) details.hidden = !enabled;
    const typeSelect = scope.querySelector('#rakeType, #roomRakeType, select[data-rake-type]');
    const type = typeSelect ? typeSelect.value : 'time';
    scope.querySelectorAll('[data-rake-fields]').forEach((el) => {
        el.hidden = el.getAttribute('data-rake-fields') !== type;
    });
}

function fillRakeFields(rake, scope) {
    if (!scope) return;
    const on = rake && rake.enabled && rake.type !== 'none';
    const enabledInputs = scope.querySelectorAll('input[name="rakeEnabled"], input[name="roomRakeEnabled"]');
    enabledInputs.forEach((el) => {
        el.checked = on ? el.value === 'yes' : el.value === 'no';
    });
    const typeSelect = scope.querySelector('#rakeType, #roomRakeType');
    if (typeSelect) typeSelect.value = on && rake.type !== 'none' ? rake.type : 'time';
    const map = {
        rakePerHour: rake.perPlayerPerHour,
        roomRakePerHour: rake.perPlayerPerHour,
        rakePercent: rake.percent,
        roomRakePercent: rake.percent,
        rakeCap: rake.cap,
        roomRakeCap: rake.cap,
        rakePerPlayer: rake.perPlayer,
        roomRakePerPlayer: rake.perPlayer,
        rakeNote: rake.note,
        roomRakeNote: rake.note
    };
    Object.keys(map).forEach((id) => {
        const el = scope.querySelector('#' + id);
        if (el) el.value = map[id] == null ? '' : map[id];
    });
    syncRakeFieldVisibility(scope);
}

function readRakeFields(prefix, scope) {
    const on = isRakeOn(scope);
    const typeSelect = scope.querySelector('#rakeType, #roomRakeType');
    const type = on ? ((typeSelect && typeSelect.value) || 'time') : 'none';
    const val = (id, fallback) => {
        const el = scope.querySelector('#' + id);
        if (!el) return fallback;
        if (el.type === 'text') return String(el.value || '').slice(0, 80);
        return Math.max(0, toNumber(el.value, fallback));
    };
    return normalizeRake({
        enabled: on,
        type,
        perPlayerPerHour: val(prefix ? 'roomRakePerHour' : 'rakePerHour', 5),
        percent: val(prefix ? 'roomRakePercent' : 'rakePercent', 5),
        cap: val(prefix ? 'roomRakeCap' : 'rakeCap', 5),
        perPlayer: val(prefix ? 'roomRakePerPlayer' : 'rakePerPlayer', 10),
        note: val(prefix ? 'roomRakeNote' : 'rakeNote', '')
    });
}

function applyRoomRakeFromForm() {
    const group = document.getElementById('roomRakeGroup');
    if (!group) return;
    gameState.rake = readRakeFields('room', group);
}

function formatRakeLabel(rake) {
    const r = rake || gameState.rake;
    if (!r || !r.enabled || r.type === 'none') return 'No rake';
    if (r.type === 'time') return `Time ${formatMoney(r.perPlayerPerHour)}/pl/hr`;
    if (r.type === 'pot') return `${money(r.percent)}% cap ${formatMoney(r.cap)}`;
    if (r.type === 'flat') return `Flat ${formatMoney(r.perPlayer)}/player`;
    if (r.type === 'custom') return (r.note && r.note.trim()) || 'Custom rake';
    return 'Rake';
}

function updateRakeDisplay() {
    const el = document.getElementById('rakeDisplay');
    if (!el) return;
    ensureHouseState();
    el.textContent = formatRakeLabel(gameState.rake);
    el.dataset.rake = gameState.rake.enabled ? 'on' : 'off';
}

function openRakeModal() {
    if (!assertCanEdit()) return;
    ensureHouseState();
    const modal = document.getElementById('rakeModal');
    fillRakeFields(gameState.rake, modal);
    if (modal) modal.style.display = 'block';
}

window.openRakeModal = openRakeModal;

function expectedRakeAmount() {
    ensureHouseState();
    const rake = gameState.rake;
    if (!rake.enabled) return null;
    const n = seatedPlayers().length;
    if (rake.type === 'flat') return money(n * rake.perPlayer);
    if (rake.type === 'time') {
        const hours = getElapsedMs() / 3600000;
        return money(n * rake.perPlayerPerHour * hours);
    }
    return null;
}

function updateRakeHint() {
    const el = document.getElementById('rakeHint');
    if (!el) return;
    ensureHouseState();
    const rake = gameState.rake;
    const expected = expectedRakeAmount();
    if (!rake.enabled) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    const houseTotal = gameState.house.reduce((sum, h) => sum + h.cashOut, 0);
    if (rake.type === 'pot') {
        el.hidden = false;
        el.textContent = `Posted rake: ${money(rake.percent)}% of each pot, cap ${formatMoney(rake.cap)}. Type what was actually collected on Host / Dealer (now ${formatMoney(houseTotal)}).`;
        return;
    }
    if (rake.type === 'custom') {
        el.hidden = false;
        el.textContent = rake.note
            ? `House rule: ${rake.note}. Type the real cash on Host / Dealer (now ${formatMoney(houseTotal)}).`
            : `Custom rake. Type the real cash on Host / Dealer (now ${formatMoney(houseTotal)}).`;
        return;
    }
    if (expected == null) {
        el.hidden = true;
        return;
    }
    const n = seatedPlayers().length;
    if (rake.type === 'time') {
        const hours = getElapsedMs() / 3600000;
        el.hidden = false;
        el.textContent = `Time rake so far about ${formatMoney(expected)} (${n} player${n === 1 ? '' : 's'} × ${formatMoney(rake.perPlayerPerHour)}/hr × ${hours.toFixed(2)} hr). Enter the real amount on Host / Dealer.`;
        return;
    }
    el.hidden = false;
    el.textContent = `Flat fee about ${formatMoney(expected)} (${n} player${n === 1 ? '' : 's'} × ${formatMoney(rake.perPlayer)}). Enter the real amount on Host / Dealer.`;
}

function getElapsedMs() {
    const c = gameState.clock || defaultClock();
    let ms = c.elapsedMs || 0;
    if (c.running && c.startedAt) {
        ms += Math.max(0, Date.now() - c.startedAt);
    }
    return ms;
}

function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function tickClock() {
    const el = document.getElementById('sessionClockTime');
    if (el) el.textContent = formatElapsed(getElapsedMs());
    updateRakeHint();
}

function startClockTicker() {
    if (clockTimer) return;
    clockTimer = setInterval(tickClock, 1000);
    tickClock();
}

function stopClockTicker() {
    if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
    }
}

function pauseClock(resetElapsed) {
    ensureHouseState();
    if (gameState.clock.running) {
        const ms = getElapsedMs();
        gameState.clock.elapsedMs = ms;
        gameState.clock.running = false;
        gameState.clock.startedAt = null;
    }
    if (resetElapsed) {
        gameState.clock.elapsedMs = 0;
        gameState.clock.running = false;
        gameState.clock.startedAt = null;
    }
    stopClockTicker();
}

function updateClockUI() {
    ensureHouseState();
    const wrap = document.getElementById('sessionClock');
    const btn = document.getElementById('sessionClockBtn');
    const resetBtn = document.getElementById('sessionClockResetBtn');
    const timeEl = document.getElementById('sessionClockTime');
    const elapsed = getElapsedMs();
    const running = !!gameState.clock.running;
    if (timeEl) timeEl.textContent = formatElapsed(elapsed);
    if (wrap) wrap.classList.toggle('is-running', running);
    if (btn) {
        btn.textContent = running ? 'Pause' : (elapsed > 0 ? 'Resume' : 'Start');
        btn.title = running ? 'Pause the session clock' : (elapsed > 0 ? 'Resume the session clock' : 'Start the session clock');
    }
    if (resetBtn) {
        resetBtn.disabled = !canEditGame() || (!running && elapsed === 0);
        resetBtn.title = 'Reset the session clock to 00:00:00';
    }
    if (running) startClockTicker();
    else stopClockTicker();
}

function toggleClock() {
    if (!assertCanEdit()) return;
    ensureHouseState();
    if (gameState.clock.running) {
        pauseClock(false);
    } else {
        gameState.clock.running = true;
        gameState.clock.startedAt = Date.now();
        startClockTicker();
    }
    saveGameState();
    updateClockUI();
}

function resetClock() {
    if (!assertCanEdit()) return;
    pauseClock(true);
    saveGameState();
    updateClockUI();
}

function updateUndoBtn() {
    const btn = document.getElementById('undoBtn');
    if (!btn) return;
    const can = canEditGame() && undoStack.length > 0;
    btn.disabled = !can;
}

function clearUndo() {
    undoStack = [];
    updateUndoBtn();
}

function recordStackUndo(playerId, previousBuyIn) {
    undoStack.push({ playerId, previousBuyIn });
    if (undoStack.length > 40) undoStack.shift();
    updateUndoBtn();
}

function undoLastStack() {
    if (!assertCanEdit()) return;
    const last = undoStack.pop();
    if (!last) {
        updateUndoBtn();
        return;
    }
    const player = seatedPlayers().find((p) => p.id === last.playerId);
    if (player) {
        player.totalBuyIn = last.previousBuyIn;
        saveGameState();
        updateDisplay();
    }
    updateUndoBtn();
}

function updateHouseCashOut(houseId, amount) {
    if (!assertCanEdit()) return;
    ensureHouseState();
    const row = gameState.house.find((h) => h.id === houseId);
    if (!row) return;
    row.cashOut = Math.max(0, money(amount));
    saveGameState();
    updateDisplay();
}

function updateHouseName(houseId, newName) {
    if (!assertCanEdit()) return;
    ensureHouseState();
    const row = gameState.house.find((h) => h.id === houseId);
    if (!row) return;
    row.name = newName.trim() || (row.kind === 'dealer' ? 'Dealer' : 'Host');
    saveGameState();
    updateDisplay();
}

function editHouseName(houseId) {
    if (!assertCanEdit()) return;
    ensureHouseState();
    const row = gameState.house.find((h) => h.id === houseId);
    if (!row) return;
    editingHouseId = houseId;
    editingPlayerId = null;
    document.getElementById('editPlayerName').value = row.name;
    const title = editNameModal.querySelector('h2');
    if (title) title.textContent = row.kind === 'dealer' ? 'Edit Dealer' : 'Edit Host';
    if (deletePlayerBtn) deletePlayerBtn.style.display = 'none';
    editNameModal.style.display = 'block';
}

function roomRoleLabel(role) {
    if (role === 'host') return 'Room host';
    return role;
}

function addPlayer(name, buyIn) {
    if (!assertCanEdit()) return;
    const player = {
        id: Date.now(),
        name: name,
        totalBuyIn: buyIn,
        cashOut: 0
    };

    gameState.players.push(player);
    saveGameState();
    updateDisplay();
}

function addStack(playerId) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        recordStackUndo(playerId, player.totalBuyIn);
        player.totalBuyIn = money(player.totalBuyIn + gameState.stackAmount);
        saveGameState();
        updateDisplay();
    }
}

function subtractStack(playerId) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        recordStackUndo(playerId, player.totalBuyIn);
        player.totalBuyIn = money(player.totalBuyIn - gameState.stackAmount);
        if (player.totalBuyIn < 0) {
            player.totalBuyIn = 0;
        }
        saveGameState();
        updateDisplay();
    }
}

function updateCashOut(playerId, amount) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        player.cashOut = amount;
        saveGameState();
        updateDisplay();
    }
}

function updateBuyIn(playerId, amount) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (!player) return;
    const next = Math.max(0, money(amount));
    if (next === money(player.totalBuyIn)) {
        updateDisplay();
        return;
    }
    recordStackUndo(playerId, player.totalBuyIn);
    player.totalBuyIn = next;
    saveGameState();
    updateDisplay();
}

function beginEditBuyIn(playerId, cell) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (!player || !cell) return;
    if (cell.querySelector('input')) return;

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'cashout-input buyin-input';
    input.min = '0';
    input.step = '0.01';
    input.value = String(player.totalBuyIn);
    input.setAttribute('aria-label', 'Total buy-in');
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const commit = () => {
        if (finished) return;
        finished = true;
        updateBuyIn(playerId, parseFloat(input.value));
    };
    const cancel = () => {
        if (finished) return;
        finished = true;
        updateDisplay();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });
}

function editPlayerName(playerId) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        editingPlayerId = playerId;
        editingHouseId = null;
        document.getElementById('editPlayerName').value = player.name;
        const title = editNameModal.querySelector('h2');
        if (title) title.textContent = 'Edit Player';
        if (deletePlayerBtn) deletePlayerBtn.style.display = '';
        editNameModal.style.display = 'block';
    }
}

function updatePlayerName(playerId, newName) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        player.name = newName;
        saveGameState();
        updateDisplay();
    }
}

function deletePlayer(playerId) {
    if (!assertCanEdit()) return;
    gameState.players = gameState.players.filter(p => p.id !== playerId);
    saveGameState();
    updateDisplay();
}

function canEditGame() {
    if (!window.RoomSync) return true;
    return RoomSync.canEdit();
}

function assertCanEdit() {
    if (canEditGame()) return true;
    const snap = window.RoomSync ? RoomSync.getRoomSnapshot() : null;
    if (snap && snap.status === 'ended') {
        alert('This room has ended. Leave the room to keep tracking on this device.');
    } else {
        alert('View only. Ask the host to grant you edit access.');
    }
    return false;
}

function calculatePnL(player) {
    return money(player.cashOut - player.totalBuyIn);
}

function cashTotals() {
    ensureHouseState();
    const players = seatedPlayers();
    const buyIn = money(players.reduce((sum, p) => sum + (p.totalBuyIn || 0), 0));
    const playerCashOut = money(players.reduce((sum, p) => sum + (p.cashOut || 0), 0));
    const houseCashOut = money(gameState.house.reduce((sum, h) => sum + (h.cashOut || 0), 0));
    const cashOut = money(playerCashOut + houseCashOut);
    return {
        buyIn,
        playerCashOut,
        houseCashOut,
        cashOut,
        balance: money(cashOut - buyIn)
    };
}

function calculateTotalBalance() {
    return cashTotals().balance;
}

function calculateSettlement() {
    ensureHouseState();
    const parties = [];
    seatedPlayers().forEach((p) => {
        const net = calculatePnL(p);
        if (Math.abs(net) >= 0.005) parties.push({ name: p.name, net });
    });
    gameState.house.forEach((h) => {
        const net = money(h.cashOut);
        if (net >= 0.005) parties.push({ name: h.name, net });
    });

    const debtors = parties
        .filter((p) => p.net < 0)
        .map((p) => ({ name: p.name, amount: money(-p.net) }))
        .sort((a, b) => b.amount - a.amount);
    const creditors = parties
        .filter((p) => p.net > 0)
        .map((p) => ({ name: p.name, amount: money(p.net) }))
        .sort((a, b) => b.amount - a.amount);

    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
        const pay = money(Math.min(debtors[i].amount, creditors[j].amount));
        if (pay >= 0.005) {
            transfers.push({ from: debtors[i].name, to: creditors[j].name, amount: pay });
        }
        debtors[i].amount = money(debtors[i].amount - pay);
        creditors[j].amount = money(creditors[j].amount - pay);
        if (debtors[i].amount < 0.005) i += 1;
        if (creditors[j].amount < 0.005) j += 1;
    }
    return transfers;
}

function updateBlindDisplay() {
    if (gameState.blindStructure.small > 0 || gameState.blindStructure.big > 0) {
        blindDisplay.textContent = `$${gameState.blindStructure.small.toFixed(2)} / $${gameState.blindStructure.big.toFixed(2)}`;
    } else {
        blindDisplay.textContent = 'Click to set';
    }
}

function updateDisplay() {
    ensureHouseState();
    updateBlindDisplay();
    updateRakeDisplay();
    updateSessionNameDisplay();
    updateBankerNameDisplay();
    updateClockUI();

    stackAmountInput.value = gameState.stackAmount;

    if (totalPlayersDisplay) {
        totalPlayersDisplay.textContent = seatedPlayers().length;
    }

    playerTableBody.innerHTML = '';

    const editable = canEditGame();
    const players = seatedPlayers();

    if (players.length === 0) {
        const empty = document.createElement('tr');
        empty.className = 'empty-players-row';
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'No players yet. Add someone to start tracking buy-ins.';
        empty.appendChild(td);
        playerTableBody.appendChild(empty);
    }

    players.forEach((player) => {
        playerTableBody.appendChild(buildPlayerRow(player, editable));
    });

    gameState.house.forEach((row) => {
        playerTableBody.appendChild(buildHouseRow(row, editable));
    });

    const totals = cashTotals();
    totalBalanceDisplay.textContent = formatMoney(totals.balance, true);
    totalBalanceDisplay.style.color = totals.balance > 0 ? '#2ecc71' : totals.balance < 0 ? '#e74c3c' : '#3498db';
    renderBalanceBreakdown(totals);
    updateRakeHint();
    renderSettlement();
    updateUndoBtn();
    applyEditabilityUI();
}

function renderBalanceBreakdown(totals) {
    const wrap = document.getElementById('balanceBreakdown');
    if (!wrap) return;
    const leftover = totals.balance;
    const leftoverClass = leftover > 0 ? 'pnl-positive' : leftover < 0 ? 'pnl-negative' : '';
    const leftoverLabel = leftover > 0 ? 'Over' : leftover < 0 ? 'Unaccounted' : 'Unaccounted';
    wrap.innerHTML = '';
    const stats = [
        ['Buy-ins', formatMoney(totals.buyIn)],
        ['Player cash-outs', formatMoney(totals.playerCashOut)],
        ['Dealer + Host', formatMoney(totals.houseCashOut)],
        [leftoverLabel, formatMoney(leftover, true)]
    ];
    stats.forEach(([label, value], index) => {
        const div = document.createElement('div');
        div.className = 'balance-stat';
        const k = document.createElement('span');
        k.className = 'balance-stat-label';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'balance-stat-value' + (index === 3 && leftoverClass ? ' ' + leftoverClass : '');
        v.textContent = value;
        div.appendChild(k);
        div.appendChild(v);
        wrap.appendChild(div);
    });
}

function renderSettlement() {
    const section = document.getElementById('settlementSection');
    const list = document.getElementById('settlementList');
    if (!section || !list) return;

    const players = seatedPlayers();
    const anyoneCashed = players.some((p) => (p.cashOut || 0) > 0)
        || gameState.house.some((h) => (h.cashOut || 0) > 0);
    const transfers = anyoneCashed ? calculateSettlement() : [];

    list.innerHTML = '';
    if (!anyoneCashed || transfers.length === 0) {
        section.hidden = true;
        return;
    }

    section.hidden = false;
    transfers.forEach((t) => {
        const li = document.createElement('li');
        li.className = 'settlement-item';
        const who = document.createElement('span');
        who.textContent = `${t.from} pays ${t.to}`;
        const amt = document.createElement('span');
        amt.className = 'amount';
        amt.textContent = formatMoney(t.amount);
        li.appendChild(who);
        li.appendChild(amt);
        list.appendChild(li);
    });
}

// Player data can come from other devices in a room, so rows are built with DOM
// APIs (never string interpolation) to keep names and ids out of markup.
function buildPlayerRow(player, editable) {
    const pnl = calculatePnL(player);
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.className = editable ? 'player-name' : 'player-name player-name-readonly';
    nameSpan.title = editable ? 'Click to edit name' : 'View only';
    nameSpan.textContent = player.name;
    if (editable) {
        nameSpan.addEventListener('click', () => editPlayerName(player.id));
    }
    nameCell.appendChild(nameSpan);

    const buyInCell = document.createElement('td');
    if (editable) {
        const buyInBtn = document.createElement('button');
        buyInBtn.type = 'button';
        buyInBtn.className = 'buyin-amount';
        buyInBtn.title = 'Tap to type a buy-in';
        buyInBtn.textContent = `$${player.totalBuyIn.toFixed(2)}`;
        buyInBtn.addEventListener('click', () => beginEditBuyIn(player.id, buyInCell));
        buyInCell.appendChild(buyInBtn);
    } else {
        buyInCell.textContent = `$${player.totalBuyIn.toFixed(2)}`;
    }

    const stackCell = document.createElement('td');
    const minusBtn = document.createElement('button');
    minusBtn.className = 'btn btn-stack-minus';
    minusBtn.textContent = '-';
    minusBtn.disabled = !editable;
    minusBtn.addEventListener('click', () => subtractStack(player.id));
    const plusBtn = document.createElement('button');
    plusBtn.className = 'btn btn-stack-plus';
    plusBtn.textContent = '+';
    plusBtn.disabled = !editable;
    plusBtn.addEventListener('click', () => addStack(player.id));
    stackCell.appendChild(minusBtn);
    stackCell.appendChild(plusBtn);

    const cashOutCell = document.createElement('td');
    const cashOutInput = document.createElement('input');
    cashOutInput.type = 'number';
    cashOutInput.className = 'cashout-input';
    cashOutInput.value = String(player.cashOut);
    cashOutInput.min = '0';
    cashOutInput.step = '0.01';
    cashOutInput.disabled = !editable;
    cashOutInput.addEventListener('change', () => {
        const amount = Math.max(0, parseFloat(cashOutInput.value) || 0);
        cashOutInput.value = String(amount);
        updateCashOut(player.id, amount);
    });
    cashOutCell.appendChild(cashOutInput);

    const pnlCell = document.createElement('td');
    pnlCell.className = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : 'pnl-zero';
    pnlCell.textContent = formatMoney(pnl, true);

    row.appendChild(nameCell);
    row.appendChild(buyInCell);
    row.appendChild(stackCell);
    row.appendChild(cashOutCell);
    row.appendChild(pnlCell);
    return row;
}

function buildHouseRow(house, editable) {
    const row = document.createElement('tr');
    row.className = 'house-row';

    const nameCell = document.createElement('td');
    const wrap = document.createElement('span');
    wrap.className = 'house-name-wrap';
    const nameSpan = document.createElement('span');
    nameSpan.className = editable ? 'player-name' : 'player-name player-name-readonly';
    nameSpan.title = editable ? 'Click to rename' : 'View only';
    nameSpan.textContent = house.name;
    if (editable) {
        nameSpan.addEventListener('click', () => editHouseName(house.id));
    }
    const badge = document.createElement('span');
    badge.className = 'house-badge';
    badge.textContent = 'House';
    wrap.appendChild(nameSpan);
    wrap.appendChild(badge);
    nameCell.appendChild(wrap);

    const buyInCell = document.createElement('td');
    buyInCell.className = 'pnl-zero';
    buyInCell.textContent = '$0.00';

    const stackCell = document.createElement('td');
    const note = document.createElement('span');
    note.className = 'house-note';
    note.textContent = house.kind === 'dealer' ? 'tip only' : 'pay only';
    stackCell.appendChild(note);

    const cashOutCell = document.createElement('td');
    const cashOutInput = document.createElement('input');
    cashOutInput.type = 'number';
    cashOutInput.className = 'cashout-input';
    cashOutInput.value = String(house.cashOut);
    cashOutInput.min = '0';
    cashOutInput.step = '0.01';
    cashOutInput.disabled = !editable;
    cashOutInput.addEventListener('change', () => {
        const amount = Math.max(0, parseFloat(cashOutInput.value) || 0);
        cashOutInput.value = String(amount);
        updateHouseCashOut(house.id, amount);
    });
    cashOutCell.appendChild(cashOutInput);

    const pnl = money(house.cashOut);
    const pnlCell = document.createElement('td');
    pnlCell.className = pnl > 0 ? 'pnl-positive' : 'pnl-zero';
    pnlCell.textContent = formatMoney(pnl, true);

    row.appendChild(nameCell);
    row.appendChild(buyInCell);
    row.appendChild(stackCell);
    row.appendChild(cashOutCell);
    row.appendChild(pnlCell);
    return row;
}

function applyEditabilityUI() {
    const editable = canEditGame();
    if (addPlayerBtn) addPlayerBtn.disabled = !editable;
    if (clearStatsBtn) clearStatsBtn.disabled = !editable;
    if (stackAmountInput) stackAmountInput.disabled = !editable;
    const clockBtn = document.getElementById('sessionClockBtn');
    if (clockBtn) clockBtn.disabled = !editable;
    const clockResetBtn = document.getElementById('sessionClockResetBtn');
    if (clockResetBtn) {
        const elapsed = getElapsedMs();
        clockResetBtn.disabled = !editable || (!gameState.clock.running && elapsed === 0);
    }
    updateUndoBtn();
    document.body.classList.toggle('room-view-only', !editable && !!(window.RoomSync && RoomSync.isInRoom()));
}

function saveGameState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
    if (window.RoomSync && RoomSync.isInRoom() && RoomSync.canEdit() && !RoomSync.isApplyingRemote()) {
        RoomSync.pushGameState(gameState).catch((err) => {
            console.error('Failed to sync room', err);
            // Leave invalidates the push session; ignore late rejections.
            if (!RoomSync.isInRoom()) return;
            const msg = (err && err.message) || 'Failed to sync room';
            setRoomError(msg);
            alert('Could not sync stacks to the room. Changes are saved only on this device.');
        });
    }
}

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// Room documents are writable by other devices, so every shared field is coerced
// to the type the rest of the app expects before it touches gameState.
function normalizeRemoteGame(remoteGame) {
    if (!remoteGame || typeof remoteGame !== 'object') return null;
    const normalized = {};

    if (remoteGame.blindStructure && typeof remoteGame.blindStructure === 'object') {
        normalized.blindStructure = {
            small: toNumber(remoteGame.blindStructure.small, 0),
            big: toNumber(remoteGame.blindStructure.big, 0)
        };
    }
    if (remoteGame.stackAmount !== undefined && remoteGame.stackAmount !== null) {
        normalized.stackAmount = toNumber(remoteGame.stackAmount, gameState.stackAmount);
    }
    if (Array.isArray(remoteGame.players)) {
        normalized.players = remoteGame.players.map((p, index) => ({
            id: toNumber(p && p.id, index),
            name: String((p && p.name) || 'Player'),
            totalBuyIn: toNumber(p && p.totalBuyIn, 0),
            cashOut: toNumber(p && p.cashOut, 0)
        }));
    }
    if (remoteGame.sessionName) normalized.sessionName = String(remoteGame.sessionName);
    if (remoteGame.bankerName) normalized.bankerName = String(remoteGame.bankerName);
    if (remoteGame.rake !== undefined) normalized.rake = normalizeRake(remoteGame.rake);
    if (remoteGame.house !== undefined) normalized.house = normalizeHouse(remoteGame.house);
    if (remoteGame.clock !== undefined) normalized.clock = normalizeClock(remoteGame.clock);

    return normalized;
}

function sharedStateKey(source) {
    return JSON.stringify({
        blindStructure: source.blindStructure,
        stackAmount: source.stackAmount,
        players: source.players,
        sessionName: source.sessionName,
        bankerName: source.bankerName,
        rake: source.rake,
        house: source.house,
        clock: source.clock
    });
}

function stashSoloSnapshot() {
    if (localStorage.getItem(SOLO_BACKUP_KEY)) return;
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) localStorage.setItem(SOLO_BACKUP_KEY, current);
}

function restoreSoloSnapshot() {
    const backup = localStorage.getItem(SOLO_BACKUP_KEY);
    if (!backup) return false;
    localStorage.setItem(STORAGE_KEY, backup);
    localStorage.removeItem(SOLO_BACKUP_KEY);
    loadGameState();
    applyTheme();
    applyFontSize();
    clearUndo();
    updateDisplay();
    return true;
}

function applyRemoteGame(remoteGame) {
    const remote = normalizeRemoteGame(remoteGame);
    if (!remote) return;

    const next = {
        blindStructure: remote.blindStructure || gameState.blindStructure,
        stackAmount: remote.stackAmount ?? gameState.stackAmount,
        players: remote.players || gameState.players,
        sessionName: remote.sessionName || gameState.sessionName,
        bankerName: remote.bankerName || gameState.bankerName,
        rake: remote.rake || defaultRake(),
        house: remote.house || defaultHouse(),
        clock: remote.clock || defaultClock()
    };

    // Joining a room replaces local data: keep a restorable copy of the solo
    // session, but only when the room would actually overwrite something else.
    if (pendingSoloStash) {
        pendingSoloStash = false;
        if (sharedStateKey(next) !== sharedStateKey(gameState)) {
            stashSoloSnapshot();
        }
    }

    Object.assign(gameState, next);
    // Keep theme prefs local; persist shared fields locally for offline view
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
    clearUndo();
    updateDisplay();
}

function loadGameState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            gameState = JSON.parse(saved);
            // Ensure darkMode property exists for backward compatibility
            if (gameState.darkMode === undefined) {
                gameState.darkMode = false;
            }
            // Ensure compactMode property exists for backward compatibility
            if (gameState.compactMode === undefined) {
                gameState.compactMode = false;
            }
            // Ensure sessionName property exists for backward compatibility
            if (!gameState.sessionName || gameState.sessionName === 'Click to name your session') {
                gameState.sessionName = 'Session Name';
            }
            // Ensure bankerName property exists for backward compatibility
            if (!gameState.bankerName || gameState.bankerName === 'Banker: Click to set') {
                gameState.bankerName = 'Banker';
            }
        } catch (e) {
            console.error('Error loading game state:', e);
        }
    }
    ensureHouseState();
}

function applyTheme() {
    if (gameState.darkMode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
}

function applyFontSize() {
    if (gameState.compactMode) {
        document.body.classList.add('compact-mode');
    } else {
        document.body.classList.remove('compact-mode');
    }
}

function exportToExcel() {
    ensureHouseState();
    if (seatedPlayers().length === 0 && gameState.house.every((h) => h.cashOut === 0)) {
        alert('No data to export. Please add players first.');
        return;
    }

    // Create CSV content with session name and banker
    const csvCell = (value) => {
        let text = String(value ?? '');
        if (/^[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    };
    const sessionName = gameState.sessionName !== 'Session Name' ? gameState.sessionName : 'Poker Session';
    const banker = gameState.bankerName !== 'Banker' ? gameState.bankerName : '';
    let csvContent = `Session: ${csvCell(sessionName)}\n`;
    if (banker) {
        csvContent += `${csvCell(banker)}\n`;
    }
    csvContent += `Date: ${new Date().toLocaleDateString()}\n`;
    csvContent += `Elapsed: ${formatElapsed(getElapsedMs())}\n`;
    csvContent += `Rake: ${csvCell(formatRakeLabel(gameState.rake))}\n\n`;
    csvContent += "Name,Role,Total Buy-in,Cash Out,P&L\n";

    seatedPlayers().forEach(player => {
        const pnl = calculatePnL(player);
        csvContent += `${csvCell(player.name)},Player,${player.totalBuyIn.toFixed(2)},${player.cashOut.toFixed(2)},${pnl.toFixed(2)}\n`;
    });
    gameState.house.forEach((row) => {
        csvContent += `${csvCell(row.name)},${row.kind === 'dealer' ? 'Dealer' : 'Host'},0.00,${row.cashOut.toFixed(2)},${row.cashOut.toFixed(2)}\n`;
    });

    const totals = cashTotals();

    csvContent += `\nSummary,,,,\n`;
    csvContent += `Total Buy-in,${totals.buyIn.toFixed(2)},,,\n`;
    csvContent += `Player Cash Out,${totals.playerCashOut.toFixed(2)},,,\n`;
    csvContent += `Dealer + Host,${totals.houseCashOut.toFixed(2)},,,\n`;
    csvContent += `Total Cash Out,${totals.cashOut.toFixed(2)},,,\n`;
    csvContent += `Total Balance,${totals.balance.toFixed(2)},,,\n`;

    const transfers = calculateSettlement();
    if (transfers.length) {
        csvContent += `\nSettlement,,,,\n`;
        transfers.forEach((t) => {
            csvContent += `${csvCell(t.from + ' pays ' + t.to)},${t.amount.toFixed(2)},,,\n`;
        });
    }

    // Add blind structure if set
    if (gameState.blindStructure.small > 0 || gameState.blindStructure.big > 0) {
        csvContent += `\nBlind Structure,,,,\n`;
        csvContent += `Small Blind / Big Blind,${gameState.blindStructure.small.toFixed(2)} / ${gameState.blindStructure.big.toFixed(2)},,,\n`;
    }

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);

    // Create filename with current date and time
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const filename = `poker-tracker-${dateStr}-${timeStr}.csv`;

    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Session Name Functions
function updateSessionNameDisplay() {
    const sessionNameElement = document.getElementById('sessionName');
    if (sessionNameElement) {
        sessionNameElement.textContent = gameState.sessionName || 'Session Name';
    }
}

function openEditSessionModal() {
    if (!assertCanEdit()) return;
    const input = document.getElementById('editSessionName');
    if (gameState.sessionName === 'Session Name') {
        input.value = '';
    } else {
        input.value = gameState.sessionName;
    }
    editSessionModal.style.display = 'block';
    input.focus();
}

// Banker Functions
function updateBankerNameDisplay() {
    const bankerNameElement = document.getElementById('bankerName');
    if (bankerNameElement) {
        bankerNameElement.textContent = gameState.bankerName || 'Banker';
    }
}

// Make function globally accessible
window.openEditBankerModal = function() {
    if (!assertCanEdit()) return;
    const modal = document.getElementById('editBankerModal');
    const select = document.getElementById('bankerSelect');
    const customGroup = document.getElementById('customBankerGroup');
    const input = document.getElementById('editBankerName');

    if (!modal || !select) {
        console.error('Banker modal elements not found', 'modal:', modal, 'select:', select);
        return;
    }

    // Populate dropdown with current players
    select.innerHTML = '<option value="">-- Select from players --</option>';
    gameState.players.forEach(player => {
        const option = document.createElement('option');
        option.value = player.name;
        option.textContent = player.name;
        select.appendChild(option);
    });
    select.innerHTML += '<option value="custom">Custom name...</option>';

    // Set current value
    const currentBanker = (gameState.bankerName || 'Banker').replace('Banker: ', '');
    if (currentBanker !== 'Banker' && currentBanker !== 'Click to set') {
        const playerExists = gameState.players.some(p => p.name === currentBanker);
        if (playerExists) {
            select.value = currentBanker;
        } else if (currentBanker) {
            select.value = 'custom';
            if (customGroup) customGroup.style.display = 'block';
            if (input) input.value = currentBanker;
        }
    }

    // Add change listener for dropdown
    select.onchange = function() {
        if (this.value === 'custom') {
            if (customGroup) customGroup.style.display = 'block';
            if (input) input.focus();
        } else {
            if (customGroup) customGroup.style.display = 'none';
        }
    };

    modal.style.display = 'block';
    select.focus();
};

// Alias for backwards compatibility
function openEditBankerModal() {
    window.openEditBankerModal();
}

// --- Room UI ---

function setRoomError(msg) {
    const el = document.getElementById('roomError');
    if (!el) return;
    if (msg) {
        el.textContent = msg;
        el.hidden = false;
    } else {
        el.textContent = '';
        el.hidden = true;
    }
}

function updateRoomStatusBar(snap) {
    const bar = document.getElementById('roomStatusBar');
    const text = document.getElementById('roomStatusText');
    const codeBadge = document.getElementById('roomCodeBadge');
    const roleBadge = document.getElementById('roomRoleBadge');
    const peopleBtn = document.getElementById('roomPeopleBtn');
    const roomBtn = document.getElementById('roomBtn');

    if (!bar || !text) return;

    if (!snap) {
        bar.className = 'room-status-bar room-status-solo';
        text.textContent = 'Solo mode';
        if (codeBadge) {
            codeBadge.hidden = true;
            codeBadge.textContent = '';
        }
        if (roleBadge) {
            roleBadge.hidden = true;
            roleBadge.textContent = '';
        }
        if (peopleBtn) peopleBtn.hidden = true;
        if (roomBtn) roomBtn.textContent = 'Room';
        return;
    }

    const ended = snap.status === 'ended';
    bar.className = 'room-status-bar ' + (ended ? 'room-status-ended' : 'room-status-live');
    text.textContent = ended ? 'Room ended' : 'Live room';
    if (codeBadge) {
        codeBadge.hidden = false;
        codeBadge.textContent = snap.code;
    }
    if (roleBadge) {
        roleBadge.hidden = false;
        roleBadge.textContent = roomRoleLabel(snap.role);
        roleBadge.dataset.role = snap.role;
    }
    if (peopleBtn) peopleBtn.hidden = false;
    if (roomBtn) roomBtn.textContent = 'Room';
}

function syncRoomModalPanels(snap) {
    const solo = document.getElementById('roomSoloPanel');
    const active = document.getElementById('roomActivePanel');
    const notConfigured = document.getElementById('roomNotConfigured');
    const title = document.getElementById('roomModalTitle');
    const configured = window.RoomSync && RoomSync.isConfigured();

    if (notConfigured) notConfigured.hidden = configured;

    if (snap) {
        if (solo) solo.hidden = true;
        if (active) active.hidden = false;
        if (title) title.textContent = 'Room';
        const codeEl = document.getElementById('activeRoomCode');
        if (codeEl) codeEl.textContent = snap.code;
        const roleEl = document.getElementById('activeRoomRole');
        if (roleEl) {
            const perm = snap.canEdit
                ? 'You can edit stacks and cash-outs.'
                : 'View only - ask the host to grant edit access.';
            roleEl.textContent = `Joined as ${snap.displayName} (${roomRoleLabel(snap.role)}). ${perm}`;
        }
        const endBtn = document.getElementById('endRoomBtn');
        if (endBtn) endBtn.hidden = !snap.isHost || snap.status === 'ended';
    } else {
        if (solo) solo.hidden = !configured;
        if (active) active.hidden = true;
        if (title) title.textContent = 'Join or create a room';
    }
}

function renderPeopleList(snap) {
    const list = document.getElementById('peopleList');
    if (!list || !snap || !window.RoomSync) return;

    const people = RoomSync.activeParticipants(snap.participants);
    list.innerHTML = '';

    if (people.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'people-empty';
        empty.textContent = 'No one here yet.';
        list.appendChild(empty);
        return;
    }

    people.forEach((p) => {
        const isMe = snap.participantId === p.id;
        const role = KNOWN_ROLES.includes(p.role) ? p.role : 'viewer';

        const li = document.createElement('li');
        li.className = 'people-item';

        const main = document.createElement('div');
        main.className = 'people-main';

        const dot = document.createElement('span');
        dot.className = `presence-dot ${p.online ? 'online' : 'offline'}`;
        dot.title = p.online ? 'Recently active' : 'Idle';

        const nameEl = document.createElement('span');
        nameEl.className = 'people-name';
        nameEl.textContent = `${p.displayName}${isMe ? ' (you)' : ''}`;

        const roleEl = document.createElement('span');
        roleEl.className = `people-role role-${role}`;
        roleEl.textContent = roomRoleLabel(role);

        main.appendChild(dot);
        main.appendChild(nameEl);
        main.appendChild(roleEl);

        const actions = document.createElement('div');
        actions.className = 'people-actions';
        if (snap.isHost && !isMe && role !== 'host') {
            const grant = role === 'viewer';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = grant ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small';
            btn.textContent = grant ? 'Allow edit' : 'Make viewer';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    await RoomSync.setParticipantRole(p.id, grant ? 'editor' : 'viewer');
                } catch (e) {
                    alert(e.message || 'Could not update role');
                } finally {
                    btn.disabled = false;
                }
            });
            actions.appendChild(btn);

            const kickBtn = document.createElement('button');
            kickBtn.type = 'button';
            kickBtn.className = 'btn btn-danger btn-small';
            kickBtn.textContent = 'Kick';
            kickBtn.title = 'Remove from room (cannot rejoin for 5 minutes)';
            kickBtn.addEventListener('click', async () => {
                const label = p.displayName || 'this person';
                if (!confirm(`Kick ${label} from the room? They cannot rejoin for 5 minutes.`)) {
                    return;
                }
                kickBtn.disabled = true;
                btn.disabled = true;
                try {
                    await RoomSync.kickParticipant(p.id);
                } catch (e) {
                    alert(e.message || 'Could not kick that person');
                    kickBtn.disabled = false;
                    btn.disabled = false;
                }
            });
            actions.appendChild(kickBtn);
        }

        li.appendChild(main);
        li.appendChild(actions);
        list.appendChild(li);
    });
}

function preferredDisplayName() {
    if (window.AppAuth && typeof AppAuth.getDisplayName === 'function') {
        return AppAuth.getDisplayName();
    }
    return (localStorage.getItem('pst_display_name') || '').trim();
}

function openRoomModal() {
    setRoomError('');
    const nameEl = document.getElementById('roomDisplayName');
    if (nameEl) {
        const name = preferredDisplayName();
        nameEl.textContent = name || 'Set your name in Settings first';
    }
    ensureHouseState();
    fillRakeFields(gameState.rake, document.getElementById('roomRakeGroup'));
    const snap = window.RoomSync ? RoomSync.getRoomSnapshot() : null;
    syncRoomModalPanels(snap);
    const modal = document.getElementById('roomModal');
    if (modal) modal.style.display = 'block';
}

window.openRoomModal = openRoomModal;

function renderSeatFromRoom() {
    const wrap = document.getElementById('seatFromRoomWrap');
    const row = document.getElementById('seatFromRoom');
    if (!wrap || !row) return;
    row.innerHTML = '';
    if (!window.RoomSync || !RoomSync.isInRoom()) {
        wrap.hidden = true;
        return;
    }
    const snap = RoomSync.getRoomSnapshot();
    if (!snap) {
        wrap.hidden = true;
        return;
    }
    const people = RoomSync.activeParticipants(snap.participants);
    const seated = new Set(seatedPlayers().map((p) => (p.name || '').trim().toLowerCase()));
    const available = people.filter((p) => !seated.has((p.displayName || '').trim().toLowerCase()));
    if (available.length === 0) {
        wrap.hidden = true;
        return;
    }
    wrap.hidden = false;
    available.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary btn-small';
        btn.textContent = p.displayName;
        btn.title = `Seat ${p.displayName} with $${gameState.stackAmount}`;
        btn.addEventListener('click', () => {
            if (!assertCanEdit()) return;
            addPlayer(p.displayName, gameState.stackAmount);
            playerModal.style.display = 'none';
            playerForm.reset();
        });
        row.appendChild(btn);
    });
}

function openPeopleModal() {
    const snap = window.RoomSync ? RoomSync.getRoomSnapshot() : null;
    if (!snap) return;
    renderPeopleList(snap);
    const modal = document.getElementById('peopleModal');
    if (modal) modal.style.display = 'block';
}

function setAuthError(msg) {
    const el = document.getElementById('authError');
    if (!el) return;
    if (msg) {
        el.textContent = msg;
        el.hidden = false;
    } else {
        el.textContent = '';
        el.hidden = true;
    }
}

function updateAccountChip() {
    const btn = document.getElementById('accountBtn');
    const nameEl = document.getElementById('accountChipName');
    const avatar = document.getElementById('accountAvatar');
    if (!btn || !nameEl) return;
    const snap = window.AppAuth ? AppAuth.snapshot() : { signedIn: false, displayName: preferredDisplayName() };
    const name = snap.displayName || (snap.signedIn ? (snap.email || 'Account') : 'You');
    nameEl.textContent = name;
    if (avatar) avatar.textContent = (name.trim().charAt(0) || '?').toUpperCase();
    btn.hidden = false;
    btn.title = snap.signedIn
        ? `Signed in${snap.providerLabel ? ' with ' + snap.providerLabel : ''}. Open Settings to change your unique display name.`
        : 'Settings: display name';
    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) signOutBtn.hidden = !snap.signedIn;
    const providerLine = document.getElementById('accountProviderLine');
    if (providerLine) {
        if (snap.signedIn) {
            const bits = [snap.providerLabel, snap.email].filter(Boolean);
            providerLine.textContent = bits.length ? bits.join(' · ') : 'Signed in';
        } else {
            providerLine.textContent = 'Saved on this device. Sign-in is required when Firebase is configured.';
        }
    }
}

function showAuthPanel(which) {
    const signIn = document.getElementById('authSignInPanel');
    const namePanel = document.getElementById('authDisplayNamePanel');
    if (signIn) signIn.hidden = which !== 'signin';
    if (namePanel) namePanel.hidden = which !== 'name';
    const lead = document.getElementById('authGateLead');
    if (lead) {
        lead.hidden = which !== 'signin';
    }
}

function lockAppForAuth() {
    appUnlocked = false;
    document.documentElement.classList.add('auth-pending');
    document.body.classList.add('auth-pending');
    showAuthPanel('signin');
}

function restoreJoinedRoom() {
    if (!window.RoomSync) return;
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    RoomSync.tryRestoreRoom().then((snap) => {
        if (snap) {
            updateRoomStatusBar(snap);
            applyEditabilityUI();
            return;
        }
        restoreSoloSnapshot();
        if (roomParam && RoomSync.isConfigured()) {
            openRoomModal();
        }
    }).catch((e) => console.warn(e));
}

function unlockApp() {
    document.documentElement.classList.remove('auth-pending');
    document.body.classList.remove('auth-pending');
    updateAccountChip();
    updateDisplay();
    initRoomUI();
    if (!appUnlocked) {
        appUnlocked = true;
        restoreJoinedRoom();
    }
}

function applyAuthSnapshot(snap) {
    if (!snap || !snap.configured) {
        unlockApp();
        return;
    }
    if (!snap.signedIn) {
        lockAppForAuth();
        return;
    }
    if (!snap.displayName) {
        document.documentElement.classList.add('auth-pending');
        document.body.classList.add('auth-pending');
        showAuthPanel('name');
        const input = document.getElementById('authDisplayNameInput');
        if (input) {
            if (!input.value) {
                input.value = (window.AppAuth && AppAuth.suggestedDisplayName()) || '';
            }
            input.focus();
        }
        return;
    }
    unlockApp();
}

async function handleAuthAction(fn, btn) {
    setAuthError('');
    if (btn) btn.disabled = true;
    try {
        const snap = await fn();
        applyAuthSnapshot(snap || (window.AppAuth && AppAuth.snapshot()));
    } catch (e) {
        setAuthError((e && e.message) || 'Sign-in failed');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function initAuthUi() {
    const googleBtn = document.getElementById('authGoogleBtn');
    const appleBtn = document.getElementById('authAppleBtn');
    const emailForm = document.getElementById('authEmailForm');
    const createBtn = document.getElementById('authEmailCreate');
    const forgotBtn = document.getElementById('authForgot');
    const nameForm = document.getElementById('authDisplayNameForm');
    const accountBtn = document.getElementById('accountBtn');
    const accountForm = document.getElementById('accountForm');
    const signOutBtn = document.getElementById('signOutBtn');

    if (googleBtn) {
        googleBtn.addEventListener('click', () => handleAuthAction(() => AppAuth.signInGoogle(), googleBtn));
    }
    if (appleBtn) {
        appleBtn.addEventListener('click', () => handleAuthAction(() => AppAuth.signInApple(), appleBtn));
    }
    if (emailForm) {
        emailForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = document.getElementById('authEmail')?.value || '';
            const password = document.getElementById('authPassword')?.value || '';
            handleAuthAction(() => AppAuth.signInEmail(email, password), document.getElementById('authEmailSignIn'));
        });
    }
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            const email = document.getElementById('authEmail')?.value || '';
            const password = document.getElementById('authPassword')?.value || '';
            handleAuthAction(() => AppAuth.createEmailAccount(email, password), createBtn);
        });
    }
    if (forgotBtn) {
        forgotBtn.addEventListener('click', async () => {
            setAuthError('');
            try {
                const email = document.getElementById('authEmail')?.value || '';
                await AppAuth.sendPasswordReset(email);
                setAuthError('Password reset email sent.');
            } catch (e) {
                setAuthError((e && e.message) || 'Could not send reset email');
            }
        });
    }
    if (nameForm) {
        nameForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            setAuthError('');
            try {
                const saved = await AppAuth.setDisplayName(document.getElementById('authDisplayNameInput')?.value || '');
                if (window.RoomSync && typeof RoomSync.updateMyDisplayName === 'function') {
                    await RoomSync.updateMyDisplayName(saved);
                }
                applyAuthSnapshot(AppAuth.snapshot());
            } catch (err) {
                setAuthError((err && err.message) || 'Enter a display name');
            }
        });
    }
    if (accountBtn) {
        accountBtn.addEventListener('click', () => {
            const input = document.getElementById('accountDisplayName');
            if (input) input.value = preferredDisplayName();
            updateAccountChip();
            const modal = document.getElementById('accountModal');
            if (modal) modal.style.display = 'block';
            if (input) input.focus();
        });
    }
    if (accountForm) {
        accountForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const value = document.getElementById('accountDisplayName')?.value || '';
            try {
                let saved = value.trim();
                if (window.AppAuth) {
                    saved = await AppAuth.setDisplayName(value);
                } else {
                    localStorage.setItem('pst_display_name', saved);
                }
                if (window.RoomSync && typeof RoomSync.updateMyDisplayName === 'function') {
                    await RoomSync.updateMyDisplayName(saved);
                }
                updateAccountChip();
                const modal = document.getElementById('accountModal');
                if (modal) modal.style.display = 'none';
            } catch (err) {
                alert((err && err.message) || 'Could not save display name');
            }
        });
    }
    if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
            if (window.RoomSync && RoomSync.isInRoom()) {
                try { await RoomSync.leaveRoom(); } catch (e) { console.warn(e); }
                updateRoomStatusBar(null);
            }
            const modal = document.getElementById('accountModal');
            if (modal) modal.style.display = 'none';
            if (window.AppAuth) await AppAuth.signOut();
            applyAuthSnapshot(window.AppAuth ? AppAuth.snapshot() : { configured: false });
        });
    }

    if (window.AppAuth) {
        AppAuth.on('user', (snap) => {
            if (snap && snap.configured && !snap.signedIn) {
                lockAppForAuth();
                return;
            }
            if (document.body.classList.contains('auth-pending') || document.documentElement.classList.contains('auth-pending')) {
                applyAuthSnapshot(snap);
            } else {
                updateAccountChip();
            }
        });
        AppAuth.on('error', (msg) => setAuthError(msg));
    }
}

async function bootApp() {
    initAuthUi();
    updateAccountChip();

    if (!window.AppAuth || !AppAuth.isConfigured()) {
        unlockApp();
        return;
    }

    lockAppForAuth();
    const providerBtns = ['authGoogleBtn', 'authAppleBtn', 'authEmailSignIn', 'authEmailCreate']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    providerBtns.forEach((btn) => { btn.disabled = true; });
    try {
        const snap = await AppAuth.init();
        applyAuthSnapshot(snap);
    } catch (e) {
        setAuthError((e && e.message) || 'Could not reach sign-in.');
        showAuthPanel('signin');
    } finally {
        providerBtns.forEach((btn) => { btn.disabled = false; });
    }
}

function initRoomUI() {
    if (roomUiReady) return;
    roomUiReady = true;
    const roomBtn = document.getElementById('roomBtn');
    const peopleBtn = document.getElementById('roomPeopleBtn');
    const createBtn = document.getElementById('createRoomBtn');
    const joinBtn = document.getElementById('joinRoomBtn');
    const leaveBtn = document.getElementById('leaveRoomBtn');
    const endBtn = document.getElementById('endRoomBtn');
    const copyBtn = document.getElementById('copyRoomCodeBtn');
    const joinCodeInput = document.getElementById('joinRoomCode');

    if (roomBtn) roomBtn.addEventListener('click', openRoomModal);
    if (peopleBtn) peopleBtn.addEventListener('click', openPeopleModal);

    if (createBtn) {
        createBtn.addEventListener('click', async () => {
            setRoomError('');
            if (!window.RoomSync || !RoomSync.isConfigured()) {
                setRoomError('Firebase is not configured. See ROOM_SETUP.md.');
                return;
            }
            const name = preferredDisplayName();
            if (!name) {
                setRoomError('Set a unique display name in Settings before creating a room.');
                return;
            }
            createBtn.disabled = true;
            try {
                applyRoomRakeFromForm();
                await RoomSync.createRoom(name, gameState);
                setRoomError('');
                syncRoomModalPanels(RoomSync.getRoomSnapshot());
                updateRoomStatusBar(RoomSync.getRoomSnapshot());
            } catch (e) {
                console.error(e);
                setRoomError(e.message || 'Could not create room');
            } finally {
                createBtn.disabled = false;
            }
        });
    }

    if (joinBtn) {
        joinBtn.addEventListener('click', async () => {
            setRoomError('');
            if (!window.RoomSync || !RoomSync.isConfigured()) {
                setRoomError('Firebase is not configured. See ROOM_SETUP.md.');
                return;
            }
            const name = preferredDisplayName();
            const code = joinCodeInput?.value || '';
            if (!name) {
                setRoomError('Set a unique display name in Settings before joining.');
                return;
            }
            if (!code.trim()) {
                setRoomError('Enter a room code.');
                joinCodeInput?.focus();
                return;
            }
            joinBtn.disabled = true;
            // Joining is the only path where the room replaces this device's
            // own session, so this is where the solo snapshot is protected.
            pendingSoloStash = true;
            try {
                await RoomSync.joinRoom(code, name);
                clearUndo();
                syncRoomModalPanels(RoomSync.getRoomSnapshot());
                updateRoomStatusBar(RoomSync.getRoomSnapshot());
            } catch (e) {
                console.error(e);
                setRoomError(e.message || 'Could not join room');
            } finally {
                if (!RoomSync.isInRoom()) pendingSoloStash = false;
                joinBtn.disabled = false;
            }
        });
    }

    if (joinCodeInput) {
        joinCodeInput.addEventListener('input', () => {
            joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        });
        joinCodeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                joinBtn?.click();
            }
        });
    }

    if (leaveBtn) {
        leaveBtn.addEventListener('click', async () => {
            if (!confirm('Leave this room? You can rejoin with the code if it is still active.')) return;
            try {
                await RoomSync.leaveRoom();
                updateRoomStatusBar(null);
                syncRoomModalPanels(null);
                applyEditabilityUI();
                document.getElementById('roomModal').style.display = 'none';
            } catch (e) {
                setRoomError(e.message || 'Could not leave room');
            }
        });
    }

    if (endBtn) {
        endBtn.addEventListener('click', async () => {
            if (!confirm('End this room for everyone? The code will stop working, and this device keeps the final numbers.')) return;
            endBtn.disabled = true;
            try {
                await RoomSync.endRoom();
                // Keep the final room snapshot as the new solo session; discard
                // the pre-room backup so leave does not restore old numbers.
                localStorage.removeItem(SOLO_BACKUP_KEY);
                pendingSoloStash = false;
                localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
                // Ending would otherwise leave the host in a read-only room, so
                // drop back to solo with the final numbers still editable.
                await RoomSync.leaveRoom();
                updateRoomStatusBar(null);
                syncRoomModalPanels(null);
                applyEditabilityUI();
                updateDisplay();
                const roomModal = document.getElementById('roomModal');
                if (roomModal) roomModal.style.display = 'none';
            } catch (e) {
                setRoomError(e.message || 'Could not end room');
            } finally {
                endBtn.disabled = false;
            }
        });
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const snap = RoomSync.getRoomSnapshot();
            if (!snap) return;
            try {
                await navigator.clipboard.writeText(snap.code);
                copyBtn.textContent = 'Copied';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            } catch (e) {
                prompt('Copy room code:', snap.code);
            }
        });
    }

    // Deep link: ?room=CODE
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && joinCodeInput) {
        joinCodeInput.value = roomParam.toUpperCase();
    }

    if (!window.RoomSync) {
        updateRoomStatusBar(null);
        return;
    }

    RoomSync.on('room', (snap) => {
        updateRoomStatusBar(snap);
        const roomModal = document.getElementById('roomModal');
        if (roomModal && roomModal.style.display === 'block') {
            syncRoomModalPanels(snap);
        }
        const peopleModal = document.getElementById('peopleModal');
        if (peopleModal && peopleModal.style.display === 'block' && snap) {
            renderPeopleList(snap);
        }
        applyEditabilityUI();

        if (!snap) {
            pendingSoloStash = false;
            clearUndo();
            // After a room ends, keep the final shared numbers as the new solo
            // session. Only restore the pre-join solo backup when leaving an
            // active room mid-session.
            if (lastRoomStatus === 'ended') {
                localStorage.removeItem(SOLO_BACKUP_KEY);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
            } else {
                restoreSoloSnapshot();
            }
            lastRoomStatus = null;
        } else {
            lastRoomStatus = snap.status || 'active';
        }

        // Room snapshots also fire on presence heartbeats; rebuilding the table
        // then would steal focus from a cash-out being typed. Game payload
        // changes arrive on the 'game' event instead.
        const editable = canEditGame();
        if (editable !== lastEditable) {
            lastEditable = editable;
            updateDisplay();
        }
    });

    RoomSync.on('game', (remoteGame) => {
        applyRemoteGame(remoteGame);
    });

    RoomSync.on('error', (msg) => {
        if (!msg) return;
        console.warn('Room:', msg);
        setRoomError(msg);
        alert(msg);
    });

    updateRoomStatusBar(RoomSync.getRoomSnapshot());
    applyEditabilityUI();
}

// Expose for onclick handlers
window.addStack = addStack;
window.subtractStack = subtractStack;
window.updateCashOut = updateCashOut;
window.updateBuyIn = updateBuyIn;
window.editPlayerName = editPlayerName;
