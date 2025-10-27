// Game state
let gameState = {
    blindStructure: { small: 0, big: 0 },
    stackAmount: 200,
    players: [],
    darkMode: false
};

// DOM Elements
const blindStructureBtn = document.getElementById('blindStructureBtn');
const addPlayerBtn = document.getElementById('addPlayerBtn');
const stackAmountInput = document.getElementById('stackAmount');
const clearStatsBtn = document.getElementById('clearStatsBtn');
const themeToggle = document.getElementById('themeToggle');
const blindDisplay = document.getElementById('blindDisplay');
const totalBalanceDisplay = document.getElementById('totalBalance');
const playerTableBody = document.getElementById('playerTableBody');
const totalPlayersDisplay = document.getElementById('totalPlayers');

// Modals
const blindModal = document.getElementById('blindModal');
const playerModal = document.getElementById('playerModal');
const blindForm = document.getElementById('blindForm');
const playerForm = document.getElementById('playerForm');

// Close buttons
const closeButtons = document.querySelectorAll('.close');

// Initialize
loadGameState();
updateDisplay();
applyTheme();

// Event Listeners
blindStructureBtn.addEventListener('click', () => {
    blindModal.style.display = 'block';
});

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

clearStatsBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all stats? This cannot be undone.')) {
        gameState.players = [];
        saveGameState();
        updateDisplay();
    }
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
        blindDisplay.textContent = '';
    }
}

function updateDisplay() {
    // Update blind display
    updateBlindDisplay();
    
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
            <td>${player.name}</td>
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
