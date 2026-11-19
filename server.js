const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game State
let gameState = 'LOBBY'; // LOBBY, PLAYING, ENDED
let lobbyTimer = 30;
let lockedCartelas = {}; // cartelaId -> { socketId, playerName }
let calledNumbers = [];
let remainingBalls = [];
let gameInterval = null;
let winnerInfo = null;

// Deterministic Card Generator (Matches Client Exactly)
function generateCartelaGrid(cartelaId) {
  let seed = cartelaId * 9301 + 49297;
  function nextRandom() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }

  const ranges = [
    { min: 1, max: 15 },
    { min: 16, max: 30 },
    { min: 31, max: 45 },
    { min: 46, max: 60 },
    { min: 61, max: 75 }
  ];

  const columns = [];
  for (let c = 0; c < 5; c++) {
    const range = ranges.at(c);
    const pool = [];
    for (let n = range.min; n <= range.max; n++) {
      pool.push(n);
    }
    const colNumbers = [];
    for (let r = 0; r < 5; r++) {
      const idx = Math.floor(nextRandom() * pool.length);
      colNumbers.push(pool.at(idx));
      pool.splice(idx, 1);
    }
    columns.push(colNumbers);
  }

  // Convert columns to 5x5 rows (row 2, col 2 is FREE = 0)
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      if (r === 2 && c === 2) {
        row.push(0);
      } else {
        row.push(columns.at(c).at(r));
      }
    }
    rows.push(row);
  }
  return rows;
}

// Validate Winning Pattern (Rows, Columns, Diagonals, 4 Corners)
function checkWin(cartelaId, calledList) {
  const grid = generateCartelaGrid(cartelaId);

  function isMarked(r, c) {
    const val = grid.at(r).at(c);
    if (val === 0) return true; // FREE space
    return calledList.includes(val);
  }

  // 1. Check 5 Horizontal Rows
  for (let r = 0; r < 5; r++) {
    let rowWin = true;
    for (let c = 0; c < 5; c++) {
      if (!isMarked(r, c)) {
        rowWin = false;
        break;
      }
    }
    if (rowWin) return 'Row ' + (r + 1);
  }

  // 2. Check 5 Vertical Columns
  for (let c = 0; c < 5; c++) {
    let colWin = true;
    for (let r = 0; r < 5; r++) {
      if (!isMarked(r, c)) {
        colWin = false;
        break;
      }
    }
    if (colWin) return 'Column ' + (c + 1);
  }

  // 3. Check Top-Left to Bottom-Right Diagonal
  if (isMarked(0, 0) && isMarked(1, 1) && isMarked(2, 2) && isMarked(3, 3) && isMarked(4, 4)) {
    return 'Diagonal (TL-BR)';
  }

  // 4. Check Top-Right to Bottom-Left Diagonal
  if (isMarked(0, 4) && isMarked(1, 3) && isMarked(2, 2) && isMarked(3, 1) && isMarked(4, 0)) {
    return 'Diagonal (TR-BL)';
  }

  // 5. Check 4 Corners
  if (isMarked(0, 0) && isMarked(0, 4) && isMarked(4, 0) && isMarked(4, 4)) {
    return '4 Corners';
  }

  return null;
}

function formatBall(num) {
  if (num <= 15) return 'B-' + num;
  if (num <= 30) return 'I-' + num;
  if (num <= 45) return 'N-' + num;
  if (num <= 60) return 'G-' + num;
  return 'O-' + num;
}

function broadcastState() {
  io.emit('stateUpdate', {
    gameState: gameState,
    lobbyTimer: lobbyTimer,
    lockedCartelas: lockedCartelas,
    calledNumbers: calledNumbers,
    winnerInfo: winnerInfo
  });
}

function resetLobby() {
  if (gameInterval) clearInterval(gameInterval);
  gameState = 'LOBBY';
  lobbyTimer = 30;
  lockedCartelas = {};
  calledNumbers = [];
  remainingBalls = [];
  winnerInfo = null;
  broadcastState();
}

function startGame() {
  if (gameInterval) clearInterval(gameInterval);
  gameState = 'PLAYING';
  calledNumbers = [];
  remainingBalls = [];
  for (let i = 1; i <= 75; i++) {
    remainingBalls.push(i);
  }
  broadcastState();

  // Draw a ball immediately, then every 3.5 seconds
  drawNextBall();
  gameInterval = setInterval(drawNextBall, 3500);
}

function drawNextBall() {
  if (gameState !== 'PLAYING') return;

  if (remainingBalls.length === 0) {
    clearInterval(gameInterval);
    gameState = 'ENDED';
    winnerInfo = {
      playerName: 'No Winner (All 75 Drawn)',
      cartelaId: '-',
      pattern: 'Round Over'
    };
    broadcastState();
    setTimeout(resetLobby, 7000);
    return;
  }

  const randIdx = Math.floor(Math.random() * remainingBalls.length);
  const drawnNumber = remainingBalls.at(randIdx);
  remainingBalls.splice(randIdx, 1);
  calledNumbers.push(drawnNumber);

  io.emit('ballCalled', {
    number: drawnNumber,
    label: formatBall(drawnNumber),
    calledNumbers: calledNumbers
  });
}

// Main 1-Second Lobby Countdown Loop
setInterval(function () {
  if (gameState === 'LOBBY') {
    const playerCount = Object.keys(lockedCartelas).length;
    if (playerCount > 0) {
      lobbyTimer = lobbyTimer - 1;
      if (lobbyTimer <= 0) {
        startGame();
      } else {
        io.emit('timerTick', lobbyTimer);
      }
    } else {
      // Hold at 30s until at least 1 cartela is picked
      if (lobbyTimer !== 30) {
        lobbyTimer = 30;
        io.emit('timerTick', lobbyTimer);
      }
    }
  }
}, 1000);

io.on('connection', function (socket) {
  socket.emit('stateUpdate', {
    gameState: gameState,
    lobbyTimer: lobbyTimer,
    lockedCartelas: lockedCartelas,
    calledNumbers: calledNumbers,
    winnerInfo: winnerInfo
  });

  socket.on('selectCartela', function (data) {
    if (gameState !== 'LOBBY') {
      socket.emit('errorMsg', 'Round already in progress! Wait for next lobby.');
      return;
    }

    const cartelaId = parseInt(data.cartelaId, 10);
    const playerName = data.playerName || 'Player';

    if (lockedCartelas[cartelaId]) {
      socket.emit('errorMsg', 'Cartela #' + cartelaId + ' is already taken!');
      return;
    }

    // Release any previous cartela held by this socket
    const keys = Object.keys(lockedCartelas);
    for (let i = 0; i < keys.length; i++) {
      const k = keys.at(i);
      if (lockedCartelas[k].socketId === socket.id) {
        delete lockedCartelas[k];
      }
    }

    lockedCartelas[cartelaId] = {
      socketId: socket.id,
      playerName: playerName
    };

    socket.emit('cartelaConfirmed', { cartelaId: cartelaId });
    broadcastState();
  });

  socket.on('claimBingo', function (data) {
    if (gameState !== 'PLAYING') return;

    const cartelaId = parseInt(data.cartelaId, 10);
    const owner = lockedCartelas[cartelaId];

    if (!owner || owner.socketId !== socket.id) {
      socket.emit('errorMsg', 'You do not own Cartela #' + cartelaId);
      return;
    }

    const winPattern = checkWin(cartelaId, calledNumbers);
    if (winPattern) {
      clearInterval(gameInterval);
      gameState = 'ENDED';
      winnerInfo = {
        playerName: owner.playerName,
        cartelaId: cartelaId,
        pattern: winPattern
      };
      io.emit('gameWon', winnerInfo);
      setTimeout(resetLobby, 8000);
    } else {
      socket.emit('errorMsg', 'False BINGO! Keep playing—you do not have a valid line yet.');
    }
  });

  socket.on('disconnect', function () {
    // Only unlock cartelas if still in LOBBY
    if (gameState === 'LOBBY') {
      const keys = Object.keys(lockedCartelas);
      let changed = false;
      for (let i = 0; i < keys.length; i++) {
        const k = keys.at(i);
        if (lockedCartelas[k].socketId === socket.id) {
          delete lockedCartelas[k];
          changed = true;
        }
      }
      if (changed) {
        broadcastState();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log('Kaleab Bingo server running on port ' + PORT);
});
