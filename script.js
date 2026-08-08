const STORAGE_KEY = 'pokerStackTracker';
const SOLO_BACKUP_KEY = 'pokerStackTracker_soloBackup';
const KNOWN_ROLES = ['host', 'editor', 'viewer'];

// Room session bookkeeping
let pendingSoloStash = false;
let lastEditable = null;

// Game state
let gameState = {
    blindStructure: { small: 1, big: 2 },
    stackAmount: 200,
    players: [],
    darkMode: true,
    compactMode: true,
    sessionName: 'Session Name',
    bankerName: 'Banker'
};

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
updateDisplay();
applyTheme();
applyFontSize();
initRoomUI();

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
    
    if (newName && editingPlayerId) {
        updatePlayerName(editingPlayerId, newName);
        editNameModal.style.display = 'none';
        editNameForm.reset();
        editingPlayerId = null;
    }
});

deletePlayerBtn.addEventListener('click', () => {
    if (!assertCanEdit()) return;
    if (editingPlayerId && confirm('Are you sure you want to delete this player? This cannot be undone.')) {
        deletePlayer(editingPlayerId);
        editNameModal.style.display = 'none';
        editNameForm.reset();
        editingPlayerId = null;
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

// Functions
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
        player.totalBuyIn += gameState.stackAmount;
        saveGameState();
        updateDisplay();
    }
}

function subtractStack(playerId) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        player.totalBuyIn -= gameState.stackAmount;
        // Don't allow negative buy-in
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

function editPlayerName(playerId) {
    if (!assertCanEdit()) return;
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        editingPlayerId = playerId;
        document.getElementById('editPlayerName').value = player.name;
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
    return player.cashOut - player.totalBuyIn;
}

function calculateTotalBalance() {
    const totalBuyIn = gameState.players.reduce((sum, p) => sum + p.totalBuyIn, 0);
    const totalCashOut = gameState.players.reduce((sum, p) => sum + p.cashOut, 0);
    return totalCashOut - totalBuyIn;
}

function updateBlindDisplay() {
    if (gameState.blindStructure.small > 0 || gameState.blindStructure.big > 0) {
        blindDisplay.textContent = `$${gameState.blindStructure.small.toFixed(2)} / $${gameState.blindStructure.big.toFixed(2)}`;
    } else {
        blindDisplay.textContent = 'Click to set';
    }
}

function updateDisplay() {
    // Update blind display
    updateBlindDisplay();
    
    // Update session name display
    updateSessionNameDisplay();
    
    // Update banker name display
    updateBankerNameDisplay();
    
    // Update stack amount
    stackAmountInput.value = gameState.stackAmount;
    
    // Update total players count
    if (totalPlayersDisplay) {
        totalPlayersDisplay.textContent = gameState.players.length;
    }
    
    // Update player table
    playerTableBody.innerHTML = '';
    
    const editable = canEditGame();

    gameState.players.forEach(player => {
        playerTableBody.appendChild(buildPlayerRow(player, editable));
    });
    
    // Update total balance
    const totalBalance = calculateTotalBalance();
    const balanceSign = totalBalance > 0 ? '+' : '';
    totalBalanceDisplay.textContent = `${balanceSign}$${totalBalance.toFixed(2)}`;
    totalBalanceDisplay.style.color = totalBalance > 0 ? '#2ecc71' : totalBalance < 0 ? '#e74c3c' : '#3498db';

    applyEditabilityUI();
}

// Player data can come from other devices in a room, so rows are built with DOM
// APIs (never string interpolation) to keep names and ids out of markup.
function buildPlayerRow(player, editable) {
    const pnl = calculatePnL(player);
    const pnlSign = pnl > 0 ? '+' : '';
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
    buyInCell.textContent = `$${player.totalBuyIn.toFixed(2)}`;

    const stackCell = document.createElement('td');
    const minusBtn = document.createElement('button');
    minusBtn.className = 'btn btn-stack-minus';
    minusBtn.textContent = '-';
    minusBtn.disabled = !editable;
    minusBtn.addEventListener('click', () => subtractStack(player.id));
    const plusBtn = document.createElement('button');
    plusBtn.className = 'btn btn-success';
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
        updateCashOut(player.id, parseFloat(cashOutInput.value) || 0);
    });
    cashOutCell.appendChild(cashOutInput);

    const pnlCell = document.createElement('td');
    pnlCell.className = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : 'pnl-zero';
    pnlCell.textContent = `${pnlSign}$${Math.abs(pnl).toFixed(2)}`;

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
    document.body.classList.toggle('room-view-only', !editable && !!(window.RoomSync && RoomSync.isInRoom()));
}

function saveGameState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
    if (window.RoomSync && RoomSync.isInRoom() && RoomSync.canEdit() && !RoomSync.isApplyingRemote()) {
        RoomSync.pushGameState(gameState).catch((err) => {
            console.error('Failed to sync room', err);
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

    return normalized;
}

function sharedStateKey(source) {
    return JSON.stringify({
        blindStructure: source.blindStructure,
        stackAmount: source.stackAmount,
        players: source.players,
        sessionName: source.sessionName,
        bankerName: source.bankerName
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
        bankerName: remote.bankerName || gameState.bankerName
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
    if (gameState.players.length === 0) {
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
    csvContent += `Date: ${new Date().toLocaleDateString()}\n\n`;
    csvContent += "Player Name,Total Buy-in,Cash Out,P&L\n";
    
    gameState.players.forEach(player => {
        const pnl = calculatePnL(player);
        csvContent += `${csvCell(player.name)},${player.totalBuyIn.toFixed(2)},${player.cashOut.toFixed(2)},${pnl.toFixed(2)}\n`;
    });
    
    // Add summary row
    const totalBuyIn = gameState.players.reduce((sum, p) => sum + p.totalBuyIn, 0);
    const totalCashOut = gameState.players.reduce((sum, p) => sum + p.cashOut, 0);
    const totalBalance = calculateTotalBalance();
    
    csvContent += `\nSummary,,,,\n`;
    csvContent += `Total Buy-in,${totalBuyIn.toFixed(2)},,,\n`;
    csvContent += `Total Cash Out,${totalCashOut.toFixed(2)},,,\n`;
    csvContent += `Total Balance,${totalBalance.toFixed(2)},,,\n`;
    
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
        roleBadge.textContent = snap.role;
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
            roleEl.textContent = `Joined as ${snap.displayName} (${snap.role}). ${perm}`;
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
        roleEl.textContent = role;

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
        }

        li.appendChild(main);
        li.appendChild(actions);
        list.appendChild(li);
    });
}

function openRoomModal() {
    setRoomError('');
    const nameInput = document.getElementById('roomDisplayName');
    if (nameInput && !nameInput.value) {
        nameInput.value = localStorage.getItem('pst_display_name') || '';
    }
    const snap = window.RoomSync ? RoomSync.getRoomSnapshot() : null;
    syncRoomModalPanels(snap);
    const modal = document.getElementById('roomModal');
    if (modal) modal.style.display = 'block';
}

function openPeopleModal() {
    const snap = window.RoomSync ? RoomSync.getRoomSnapshot() : null;
    if (!snap) return;
    renderPeopleList(snap);
    const modal = document.getElementById('peopleModal');
    if (modal) modal.style.display = 'block';
}

function initRoomUI() {
    const roomBtn = document.getElementById('roomBtn');
    const peopleBtn = document.getElementById('roomPeopleBtn');
    const createBtn = document.getElementById('createRoomBtn');
    const joinBtn = document.getElementById('joinRoomBtn');
    const leaveBtn = document.getElementById('leaveRoomBtn');
    const endBtn = document.getElementById('endRoomBtn');
    const copyBtn = document.getElementById('copyRoomCodeBtn');
    const openPeopleBtn = document.getElementById('openPeopleBtn');
    const joinCodeInput = document.getElementById('joinRoomCode');

    if (roomBtn) roomBtn.addEventListener('click', openRoomModal);
    if (peopleBtn) peopleBtn.addEventListener('click', openPeopleModal);
    if (openPeopleBtn) {
        openPeopleBtn.addEventListener('click', () => {
            document.getElementById('roomModal').style.display = 'none';
            openPeopleModal();
        });
    }

    if (createBtn) {
        createBtn.addEventListener('click', async () => {
            setRoomError('');
            if (!window.RoomSync || !RoomSync.isConfigured()) {
                setRoomError('Firebase is not configured. See ROOM_SETUP.md.');
                return;
            }
            const name = document.getElementById('roomDisplayName')?.value?.trim() || 'Host';
            createBtn.disabled = true;
            try {
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
            const name = document.getElementById('roomDisplayName')?.value?.trim() || 'Player';
            const code = joinCodeInput?.value || '';
            joinBtn.disabled = true;
            // Joining is the only path where the room replaces this device's
            // own session, so this is where the solo snapshot is protected.
            pendingSoloStash = true;
            try {
                await RoomSync.joinRoom(code, name);
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
            restoreSoloSnapshot();
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
        if (msg) console.warn('Room:', msg);
    });

    updateRoomStatusBar(RoomSync.getRoomSnapshot());
    applyEditabilityUI();

    RoomSync.tryRestoreRoom().then((snap) => {
        if (snap) {
            updateRoomStatusBar(snap);
            applyEditabilityUI();
            return;
        }
        // The room is gone: do not strand the device on room data.
        restoreSoloSnapshot();
        if (roomParam && RoomSync.isConfigured()) {
            // Offer join UI prefilled
            openRoomModal();
        }
    }).catch((e) => console.warn(e));
}

// Expose for onclick handlers
window.addStack = addStack;
window.subtractStack = subtractStack;
window.updateCashOut = updateCashOut;
window.editPlayerName = editPlayerName;
