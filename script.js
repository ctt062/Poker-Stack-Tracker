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

// Close buttons
const closeButtons = document.querySelectorAll('.close');

// Event Listeners
// Function to open blind modal (called from HTML onclick)
function openBlindModal() {
    blindModal.style.display = 'block';
}

// Make function globally accessible
window.openBlindModal = openBlindModal;

addPlayerBtn.addEventListener('click', () => {
    document.getElementById('playerBuyIn').value = gameState.stackAmount;
    playerModal.style.display = 'block';
});

stackAmountInput.addEventListener('change', (e) => {
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
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        player.totalBuyIn += gameState.stackAmount;
        saveGameState();
        updateDisplay();
    }
}

function subtractStack(playerId) {
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
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        player.cashOut = amount;
        saveGameState();
        updateDisplay();
    }
}

function editPlayerName(playerId) {
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        editingPlayerId = playerId;
        document.getElementById('editPlayerName').value = player.name;
        editNameModal.style.display = 'block';
    }
}

function updatePlayerName(playerId, newName) {
    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
        player.name = newName;
        saveGameState();
        updateDisplay();
    }
}

function deletePlayer(playerId) {
    gameState.players = gameState.players.filter(p => p.id !== playerId);
    saveGameState();
    updateDisplay();
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
    
    gameState.players.forEach(player => {
        const pnl = calculatePnL(player);
        const pnlClass = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : 'pnl-zero';
        const pnlSign = pnl > 0 ? '+' : '';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><span class="player-name" onclick="editPlayerName(${player.id})" title="Click to edit name">${player.name}</span></td>
            <td>$${player.totalBuyIn.toFixed(2)}</td>
            <td>
                <button class="btn btn-stack-minus" onclick="subtractStack(${player.id})">-</button>
                <button class="btn btn-success" onclick="addStack(${player.id})">+</button>
            </td>
            <td>
                <input 
                    type="number" 
                    class="cashout-input" 
                    value="${player.cashOut}" 
                    min="0" 
                    step="0.01"
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
}

function saveGameState() {
    localStorage.setItem('pokerStackTracker', JSON.stringify(gameState));
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
    console.log('openEditBankerModal called');
    const modal = document.getElementById('editBankerModal');
    const select = document.getElementById('bankerSelect');
    const customGroup = document.getElementById('customBankerGroup');
    const input = document.getElementById('editBankerName');
    
    console.log('Modal:', modal, 'Select:', select);
    
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
