const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('WARNING: DATABASE_URL not set!');
    return;
  }
  await pool.query(
    'CREATE TABLE IF NOT EXISTS users (' +
    'telegram_id VARCHAR(64) PRIMARY KEY, ' +
    'first_name VARCHAR(128), ' +
    'balance NUMERIC(12, 2) DEFAULT 50.00, ' +
    'created_at TIMESTAMP DEFAULT NOW()' +
    ')'
  );
  console.log('PostgreSQL users table ready.');
}
initDB();

function verifyTelegramInitData(initData) {
  const botToken = process.env.BOT_TOKEN;
  if (!initData || !botToken) return null;

  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  if (!hash) return null;

  urlParams.delete('hash');
  const keys = Array.from(urlParams.keys()).sort();
  const dataCheckArr = new Array();
  for (let i = 0; i < keys.length; i++) {
    const k = keys.at(i);
    dataCheckArr.push(k + '=' + urlParams.get(k));
  }
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculatedHash !== hash) return null;

  const userStr = urlParams.get('user');
  if (!userStr) return null;
  return JSON.parse(userStr);
}

const ENTRY_FEE = 10;
const HOUSE_CUT = 0.20;

let gameState = 'LOBBY';
let lobbyTimer = 30;
let lockedCartelas = {};
let calledNumbers = new Array();
let remainingBalls = new Array();
let gameInterval = null;
let winnerInfo = null;

function getPrizePool() {
  const count = Object.keys(lockedCartelas).length;
  const totalPot = count * ENTRY_FEE;
  return Math.floor(totalPot * (1 - HOUSE_CUT));
}

function generateCartelaGrid(cartelaId) {
  let seed = cartelaId * 9301 + 49297;
  function nextRandom() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }

  const ranges = new Array(
    { min: 1, max: 15 },
    { min: 16, max: 30 },
    { min: 31, max: 45 },
    { min: 46, max: 60 },
    { min: 61, max: 75 }
  );

  const columns = new Array();
  for (let c = 0; c < 5; c++) {
    const range = ranges.at(c);
    const pool = new Array();
    for (let n = range.min; n <= range.max; n++) {
      pool.push(n);
    }
    const colNumbers = new Array();
    for (let r = 0; r < 5; r++) {
      const idx = Math.floor(nextRandom() * pool.length);
      colNumbers.push(pool.at(idx));
      pool.splice(idx, 1);
    }
    columns.push(colNumbers);
  }

  const rows = new Array();
  for (let r = 0; r < 5; r++) {
    const row = new Array();
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

function checkWin(cartelaId, calledList) {
  const grid = generateCartelaGrid(cartelaId);

  function isMarked(r, c) {
    const val = grid.at(r).at(c);
    if (val === 0) return true;
    return calledList.includes(val);
  }

  for (let r = 0; r < 5; r++) {
    let rowWin = true;
    for (let c = 0; c < 5; c++) {
      if (!isMarked(r, c)) { rowWin = false; break; }
    }
    if (rowWin) return 'Row ' + (r + 1);
  }

  for (let c = 0; c < 5; c++) {
    let colWin = true;
    for (let r = 0; r < 5; r++) {
      if (!isMarked(r, c)) { colWin = false; break; }
    }
    if (colWin) return 'Column ' + (c + 1);
  }

  if (isMarked(0, 0) && isMarked(1, 1) && isMarked(2, 2) && isMarked(3, 3) && isMarked(4, 4)) {
    return 'Diagonal (TL-BR)';
  }
  if (isMarked(0, 4) && isMarked(1, 3) && isMarked(2, 2) && isMarked(3, 1) && isMarked(4, 0)) {
    return 'Diagonal (TR-BL)';
  }
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
    winnerInfo: winnerInfo,
    prizePool: getPrizePool(),
    entryFee: ENTRY_FEE
  });
}

function resetLobby() {
  if (gameInterval) clearInterval(gameInterval);
  gameState = 'LOBBY';
  lobbyTimer = 30;
  lockedCartelas = {};
  calledNumbers = new Array();
  remainingBalls = new Array();
  winnerInfo = null;
  broadcastState();
}

function startGame() {
  if (gameInterval) clearInterval(gameInterval);
  gameState = 'PLAYING';
  calledNumbers = new Array();
  remainingBalls = new Array();
  for (let i = 1; i <= 75; i++) {
    remainingBalls.push(i);
  }
  broadcastState();
  drawNextBall();
  gameInterval = setInterval(drawNextBall, 3500);
}
function drawNextBall() {
  if (gameState !== 'PLAYING') return;

  if (remainingBalls.length === 0) {
    clearInterval(gameInterval);
    gameState = 'ENDED';
    winnerInfo = {
      playerName: 'No Winner',
      cartelaId: '-',
      pattern: 'All 75 Drawn',
      prize: 0
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
    } else if (lobbyTimer !== 30) {
      lobbyTimer = 30;
      io.emit('timerTick', lobbyTimer);
    }
  }
}, 1000);

io.on('connection', function (socket) {
  socket.emit('stateUpdate', {
    gameState: gameState,
    lobbyTimer: lobbyTimer,
    lockedCartelas: lockedCartelas,
    calledNumbers: calledNumbers,
    winnerInfo: winnerInfo,
    prizePool: getPrizePool(),
    entryFee: ENTRY_FEE
  });

  socket.on('authUser', async function (data) {
    try {
      const verifiedUser = verifyTelegramInitData(data.initData);
      let tgId = null;
      let firstName = 'Player';

      if (verifiedUser) {
        tgId = String(verifiedUser.id);
        firstName = verifiedUser.first_name || 'Player';
      } else if (data.fallbackId) {
        tgId = String(data.fallbackId);
        firstName = data.fallbackName || 'Player';
      } else {
        socket.emit('errorMsg', 'Open inside Telegram to load your ETB Wallet.');
        return;
      }

      socket.telegramId = tgId;
      socket.playerName = firstName;

      await pool.query(
        'INSERT INTO users (telegram_id, first_name, balance) VALUES ($1, $2, 50.00) ' +
        'ON CONFLICT (telegram_id) DO UPDATE SET first_name = $2',
        [tgId, firstName]
      );

      const res = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [tgId]);
      const balance = parseFloat(res.rows.at(0).balance);

      socket.emit('walletUpdate', {
        telegramId: tgId,
        playerName: firstName,
        balance: balance
      });
    } catch (err) {
      console.error('Auth error:', err);
      socket.emit('errorMsg', 'Database error loading wallet.');
    }
  });

  socket.on('selectCartela', async function (data) {
    if (gameState !== 'LOBBY') {
      socket.emit('errorMsg', 'Round in progress! Wait for next lobby.');
      return;
    }
    if (!socket.telegramId) {
      socket.emit('errorMsg', 'Wallet not loaded yet. Please reload.');
      return;
    }

    const cartelaId = parseInt(data.cartelaId, 10);
    if (lockedCartelas[cartelaId]) {
      socket.emit('errorMsg', 'Cartela #' + cartelaId + ' is already taken!');
      return;
    }

    const keys = Object.keys(lockedCartelas);
    for (let i = 0; i < keys.length; i++) {
      const k = keys.at(i);
      if (lockedCartelas[k].telegramId === socket.telegramId) {
        socket.emit('errorMsg', 'You already locked Cartela #' + k + ' for this round!');
        return;
      }
    }

    try {
      const updateRes = await pool.query(
        'UPDATE users SET balance = balance - $1 WHERE telegram_id = $2 AND balance >= $1 RETURNING balance',
        [ENTRY_FEE, socket.telegramId]
      );

      if (updateRes.rows.length === 0) {
        socket.emit('errorMsg', 'Insufficient balance! You need ' + ENTRY_FEE + ' ETB.');
        return;
      }

      const newBalance = parseFloat(updateRes.rows.at(0).balance);

      lockedCartelas[cartelaId] = {
        socketId: socket.id,
        telegramId: socket.telegramId,
        playerName: socket.playerName || 'Player'
      };

      socket.emit('walletUpdate', { balance: newBalance });
      socket.emit('cartelaConfirmed', { cartelaId: cartelaId });
      broadcastState();
    } catch (err) {
      console.error('Select error:', err);
      socket.emit('errorMsg', 'Error processing entry fee.');
    }
  });

  socket.on('claimBingo', async function (data) {
    if (gameState !== 'PLAYING') return;

    const cartelaId = parseInt(data.cartelaId, 10);
    const owner = lockedCartelas[cartelaId];

    if (!owner || owner.telegramId !== socket.telegramId) {
      socket.emit('errorMsg', 'You do not own Cartela #' + cartelaId);
      return;
    }

    const winPattern = checkWin(cartelaId, calledNumbers);
    if (winPattern) {
      clearInterval(gameInterval);
      gameState = 'ENDED';

      const prizeAmount = getPrizePool();

      try {
        const winRes = await pool.query(
          'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2 RETURNING balance',
          [prizeAmount, owner.telegramId]
        );
        if (winRes.rows.length > 0) {
          socket.emit('walletUpdate', { balance: parseFloat(winRes.rows.at(0).balance) });
        }
      } catch (err) {
        console.error('Prize payout error:', err);
      }

      winnerInfo = {
        playerName: owner.playerName,
        cartelaId: cartelaId,
        pattern: winPattern,
        prize: prizeAmount
      };

      io.emit('gameWon', winnerInfo);
      setTimeout(resetLobby, 8000);
    } else {
      socket.emit('errorMsg', 'False BINGO! Keep playing—no valid line yet.');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log('Kaleab Bingo server running on port ' + PORT);
});
