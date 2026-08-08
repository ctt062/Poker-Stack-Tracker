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
    const newName = document.getElementById('editPlayerName').value.trim();
    
    if (newName && editingPlayerId) {
        updatePlayerName(editingPlayerId, newName);
        editNameModal.style.display = 'none';
        editNameForm.reset();
        editingPlayerId = null;
    }
});

deletePlayerBtn.addEventListener('click', () => {
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
    alert('View only. Ask the host to grant you edit access.');
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
        const pnl = calculatePnL(player);
        const pnlClass = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : 'pnl-zero';
        const pnlSign = pnl > 0 ? '+' : '';
        const nameTitle = editable ? 'Click to edit name' : 'View only';
        const nameClass = editable ? 'player-name' : 'player-name player-name-readonly';
        const nameClick = editable ? `onclick="editPlayerName(${player.id})"` : '';
        const disabledAttr = editable ? '' : 'disabled';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><span class="${nameClass}" ${nameClick} title="${nameTitle}">${player.name}</span></td>
            <td>$${player.totalBuyIn.toFixed(2)}</td>
            <td>
                <button class="btn btn-stack-minus" onclick="subtractStack(${player.id})" ${disabledAttr}>-</button>
                <button class="btn btn-success" onclick="addStack(${player.id})" ${disabledAttr}>+</button>
            </td>
            <td>
                <input 
                    type="number" 
                    class="cashout-input" 
                    value="${player.cashOut}" 
                    min="0" 
                    step="0.01"
                    ${disabledAttr}
                    onchange="updateCashOut(${player.id}, parseFloat(this.value) || 0)"
                >
            </td>
            <td class="${pnlClass}">${pnlSign}$${Math.abs(pnl).toFixed(2)}</td>
        `;
        playerTableBody.appendChild(row);
    });
    
    // Update total balance
    const totalBalance = calculateTotalBalance();
    const balanceSign = totalBalance > 0 ? '+' : '';
    totalBalanceDisplay.textContent = `${balanceSign}$${totalBalance.toFixed(2)}`;
    totalBalanceDisplay.style.color = totalBalance > 0 ? '#2ecc71' : totalBalance < 0 ? '#e74c3c' : '#3498db';

    applyEditabilityUI();
}

function applyEditabilityUI() {
    const editable = canEditGame();
    if (addPlayerBtn) addPlayerBtn.disabled = !editable;
    if (clearStatsBtn) clearStatsBtn.disabled = !editable;
    if (stackAmountInput) stackAmountInput.disabled = !editable;
    document.body.classList.toggle('room-view-only', !editable && !!(window.RoomSync && RoomSync.isInRoom()));
}

function saveGameState() {
    localStorage.setItem('pokerStackTracker', JSON.stringify(gameState));
    if (window.RoomSync && RoomSync.isInRoom() && RoomSync.canEdit() && !RoomSync.isApplyingRemote()) {
        RoomSync.pushGameState(gameState).catch((err) => {
            console.error('Failed to sync room', err);
        });
    }
}

function applyRemoteGame(remoteGame) {
    if (!remoteGame) return;
    gameState.blindStructure = remoteGame.blindStructure || gameState.blindStructure;
    gameState.stackAmount = remoteGame.stackAmount ?? gameState.stackAmount;
    gameState.players = Array.isArray(remoteGame.players) ? remoteGame.players : gameState.players;
    gameState.sessionName = remoteGame.sessionName || gameState.sessionName;
    gameState.bankerName = remoteGame.bankerName || gameState.bankerName;
    // Keep theme prefs local; persist shared fields locally for offline view
    localStorage.setItem('pokerStackTracker', JSON.stringify(gameState));
    updateDisplay();
}

function loadGameState() {
    const saved = localStorage.getItem('pokerStackTracker');
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
    const sessionName = gameState.sessionName !== 'Session Name' ? gameState.sessionName : 'Poker Session';
    const banker = gameState.bankerName !== 'Banker' ? gameState.bankerName : '';
    let csvContent = `Session: ${sessionName}\n`;
    if (banker) {
        csvContent += `${banker}\n`;
    }
    csvContent += `Date: ${new Date().toLocaleDateString()}\n\n`;
    csvContent += "Player Name,Total Buy-in,Cash Out,P&L\n";
    
    gameState.players.forEach(player => {
        const pnl = calculatePnL(player);
        csvContent += `${player.name},${player.totalBuyIn.toFixed(2)},${player.cashOut.toFixed(2)},${pnl.toFixed(2)}\n`;
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
                : 'View only — ask the host to grant edit access.';
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
        list.innerHTML = '<li class="people-empty">No one here yet.</li>';
        return;
    }

    people.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'people-item';
        const onlineDot = p.online ? 'online' : 'offline';
        const isMe = snap.participantId === p.id;
        const name = `${p.displayName}${isMe ? ' (you)' : ''}`;

        let actions = '';
        if (snap.isHost && !isMe && p.role !== 'host') {
            if (p.role === 'viewer') {
                actions = `<button type="button" class="btn btn-primary btn-small" data-grant="${p.id}">Allow edit</button>`;
            } else if (p.role === 'editor') {
                actions = `<button type="button" class="btn btn-secondary btn-small" data-revoke="${p.id}">Make viewer</button>`;
            }
        }

        li.innerHTML = `
            <div class="people-main">
                <span class="presence-dot ${onlineDot}" title="${p.online ? 'Recently active' : 'Idle'}"></span>
                <span class="people-name">${escapeHtml(name)}</span>
                <span class="people-role role-${p.role}">${p.role}</span>
            </div>
            <div class="people-actions">${actions}</div>
        `;
        list.appendChild(li);
    });

    list.querySelectorAll('[data-grant]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await RoomSync.setParticipantRole(btn.getAttribute('data-grant'), 'editor');
            } catch (e) {
                alert(e.message || 'Could not update role');
            }
        });
    });
    list.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await RoomSync.setParticipantRole(btn.getAttribute('data-revoke'), 'viewer');
            } catch (e) {
                alert(e.message || 'Could not update role');
            }
        });
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
            try {
                await RoomSync.joinRoom(code, name);
                syncRoomModalPanels(RoomSync.getRoomSnapshot());
                updateRoomStatusBar(RoomSync.getRoomSnapshot());
            } catch (e) {
                console.error(e);
                setRoomError(e.message || 'Could not join room');
            } finally {
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
            if (!confirm('End this room for everyone? The code will stop working.')) return;
            try {
                await RoomSync.endRoom();
                updateRoomStatusBar(RoomSync.getRoomSnapshot());
                syncRoomModalPanels(RoomSync.getRoomSnapshot());
            } catch (e) {
                setRoomError(e.message || 'Could not end room');
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
        updateDisplay();
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
        } else if (roomParam && RoomSync.isConfigured()) {
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

