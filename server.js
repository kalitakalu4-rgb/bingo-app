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

// PostgreSQL Database Setup
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
    'balance NUMERIC(12, 2) DEFAULT 0.00, ' +
    'created_at TIMESTAMP DEFAULT NOW()' +
    ')'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS transactions (' +
    'id SERIAL PRIMARY KEY, ' +
    'telegram_id VARCHAR(64), ' +
    'type VARCHAR(20), ' +
    'amount NUMERIC(12, 2), ' +
    'details TEXT, ' +
    'status VARCHAR(20) DEFAULT \'pending\', ' +
    'created_at TIMESTAMP DEFAULT NOW()' +
    ')'
  );
  console.log('PostgreSQL users & transactions tables ready.');
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

// Game & Stake Settings
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
// Socket.IO Game Handlers
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
      socket.join('user_' + tgId);

      await pool.query(
        'INSERT INTO users (telegram_id, first_name, balance) VALUES ($1, $2, 0.00) ' +
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
        socket.emit('errorMsg', 'Insufficient balance! Tap Deposit to top up ETB.');
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

// Telegram Bot Helpers (Deposit, Withdraw, Admin Approval)
async function tgApi(method, payload) {
  const token = process.env.BOT_TOKEN;
  if (!token) return null;
    const tgBase = 'https://' + 'api.' + 'telegram.org' + '/bot';
  const resp = await fetch(tgBase + token + '/' + method, {

    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return resp.json();
}

async function sendDepositInstructions(chatId) {
  const telebirr = process.env.TELEBIRR_ACCOUNT || '09XXXXXXXX (Set TELEBIRR_ACCOUNT on Render)';
  const cbe = process.env.CBE_ACCOUNT || '1000XXXXXXXXX (Set CBE_ACCOUNT on Render)';

  const msg =
    '💳 *DEPOSIT ETB TO YOUR WALLET*\n\n' +
    '1️⃣ Transfer your desired amount (Min: 20 ETB) to either account:\n\n' +
    '📱 *Telebirr:* `' + telebirr + '`\n' +
    '🏦 *CBE:* `' + cbe + '`\n\n' +
    '2️⃣ *Send the payment screenshot photo* right here in this chat.\n\n' +
    '⚡ Your balance will be credited within 1–3 minutes after admin verification.';

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: msg,
    parse_mode: 'Markdown'
  });
}

let lastUpdateId = 0;
async function pollTelegramUpdates() {
  const token = process.env.BOT_TOKEN;
  const appUrl = process.env.RENDER_EXTERNAL_URL || 'https://onrender.com';
  const adminChatId = process.env.ADMIN_CHAT_ID;
    if (!token) return;
    

  try {
        const tgBase = 'https://' + 'api.' + 'telegram.org' + '/bot';
    const resp = await fetch(tgBase + token + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=10');

    const data = await resp.json();

    if (data.ok && data.result) {
      for (let i = 0; i < data.result.length; i++) {
        const upd = data.result.at(i);
        lastUpdateId = upd.update_id;

        // 1. Handle Text Commands & Deposit Screenshots
        if (upd.message) {
          const chatId = upd.message.chat.id;
          const chatType = upd.message.chat.type;
          const fromUser = upd.message.from;
          const tgId = fromUser ? String(fromUser.id) : String(chatId);
          const firstName = fromUser ? (fromUser.first_name || 'Player') : 'Player';
          const text = upd.message.text || '';

          // Utility command to discover Admin Group ID
          if (text.startsWith('/groupid')) {

            await tgApi('sendMessage', {
              chat_id: chatId,
              text: 'Chat ID: `' + chatId + '`',
              parse_mode: 'Markdown'
            });
            continue;
          }

          // Only process player commands in private chats
          if (chatType === 'private') {
            await pool.query(
              'INSERT INTO users (telegram_id, first_name, balance) VALUES ($1, $2, 0.00) ON CONFLICT (telegram_id) DO NOTHING',
              [tgId, firstName]
            );

            if (text === '/start') {
              const balRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [tgId]);
              const curBal = balRes.rows.length > 0 ? parseFloat(balRes.rows.at(0).balance).toFixed(2) : '0.00';

              await tgApi('sendMessage', {
                chat_id: chatId,
                text: 'Welcome to ድል BINGO, ' + firstName + '! 🎉\n\n💰 Current Balance: *' + curBal + ' ETB*\n\nChoose an option below:',
                parse_mode: 'Markdown',
                reply_markup: {
                  keyboard: new Array(
                    new Array({ text: '💳 Deposit' }, { text: '💸 Withdraw' }),
                    new Array({ text: '💰 My Balance' })
                  ),
                  resize_keyboard: true
                }
              });

              await tgApi('sendMessage', {
                chat_id: chatId,
                text: 'Tap below to enter the 100-Cartela Bingo Arena:',
                reply_markup: {
                  inline_keyboard: new Array(
                    new Array({ text: '🎮 Play Kaleab Bingo', web_app: { url: appUrl } })
                  )
                }
              });
            } else if (text === '/deposit' || text === '💳 Deposit') {
              await sendDepositInstructions(chatId);
            } else if (text === '/balance' || text === '💰 My Balance') {
              const balRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [tgId]);
              const curBal = balRes.rows.length > 0 ? parseFloat(balRes.rows.at(0).balance).toFixed(2) : '0.00';
              await tgApi('sendMessage', {
                chat_id: chatId,
                text: '💰 Your Wallet Balance: *' + curBal + ' ETB*',
                parse_mode: 'Markdown'
              });
            } else if (text === '/withdraw' || text === '💸 Withdraw') {
              await tgApi('sendMessage', {
                chat_id: chatId,
                text:
                  '💸 *WITHDRAW ETB*\n\n' +
                  'Send your request in this format:\n' +
                  '`/withdraw AMOUNT METHOD ACCOUNT`\n\n' +
                  'Examples:\n' +
                  '`/withdraw 100 Telebirr 0912345678`\n' +
                  '`/withdraw 250 CBE 1000123456789`',
                parse_mode: 'Markdown'
              });
            } else if (text.startsWith('/withdraw ')) {
              const parts = text.trim().split(/\s+/);
              if (parts.length < 4) {
                await tgApi('sendMessage', {
                  chat_id: chatId,
                                    text: '❌ Invalid format. Use:\n`/withdraw 100 Telebirr 0912345678`',
                  parse_mode: 'Markdown'
                });
                continue;
              }
              const amount = parseFloat(parts.at(1));
              const method = parts.at(2);
              const account = parts.slice(3).join(' ');

              if (isNaN(amount) || amount < 50) {
                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: '❌ Minimum withdrawal is 50 ETB.'
                });
                continue;
              }

              const deductRes = await pool.query(
                'UPDATE users SET balance = balance - $1 WHERE telegram_id = $2 AND balance >= $1 RETURNING balance',
                [amount, tgId]
              );

              if (deductRes.rows.length === 0) {
                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: '❌ Insufficient ETB balance for this withdrawal.'
                });
                continue;
              }

              const newBal = parseFloat(deductRes.rows.at(0).balance);
              io.to('user_' + tgId).emit('walletUpdate', { balance: newBal });

              const txRes = await pool.query(
                'INSERT INTO transactions (telegram_id, type, amount, details, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [tgId, 'withdraw', amount, method + ' - ' + account, 'pending']
              );
              const txId = txRes.rows.at(0).id;

              await tgApi('sendMessage', {
                chat_id: chatId,
                text: '✅ Withdrawal request #' + txId + ' for *' + amount + ' ETB* submitted!\nNew Balance: *' + newBal.toFixed(2) + ' ETB*',
                parse_mode: 'Markdown'
              });

              if (adminChatId) {
                await tgApi('sendMessage', {
                  chat_id: adminChatId,
                  text:
                    '🚨 *NEW WITHDRAWAL REQUEST #' + txId + '*\n\n' +
                    '👤 Player: ' + firstName + ' (`' + tgId + '`)\n' +
                    '💵 Amount: *' + amount + ' ETB*\n' +
                    '🏦 Method: *' + method + '*\n' +
                    '🔢 Account: `' + account + '`',
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: new Array(
                      new Array(
                        { text: '✅ Mark Paid', callback_data: 'wd_paid_' + txId + '_' + tgId + '_' + amount },
                        { text: '❌ Reject & Refund', callback_data: 'wd_rej_' + txId + '_' + tgId + '_' + amount }
                      )
                    )
                  }
                });
              }
            } else if (upd.message.photo && upd.message.photo.length > 0) {
              const largestPhoto = upd.message.photo.at(upd.message.photo.length - 1);
              const fileId = largestPhoto.file_id;
              const captionNote = upd.message.caption || 'No caption';

              await tgApi('sendMessage', {
                chat_id: chatId,
                text: '⏳ Screenshot received! Sent to Admin for verification. You will be notified once approved.'
              });

              if (adminChatId) {
                await tgApi('sendPhoto', {
                  chat_id: adminChatId,
                  photo: fileId,
                  caption:
                    '📥 NEW DEPOSIT SCREENSHOT\n' +
                    'Player: ' + firstName + ' (' + tgId + ')\n' +
                    'Note: ' + captionNote + '\n\n' +
                    'Tap amount to credit wallet:',
                  reply_markup: {
                    inline_keyboard: new Array(
                      new Array(
                        { text: '✅ +50 ETB', callback_data: 'dep_ok_' + tgId + '_50' },
                        { text: '✅ +100 ETB', callback_data: 'dep_ok_' + tgId + '_100' }
                      ),
                      new Array(
                        { text: '✅ +200 ETB', callback_data: 'dep_ok_' + tgId + '_200' },
                        { text: '✅ +500 ETB', callback_data: 'dep_ok_' + tgId + '_500' }
                      ),
                      new Array(
                        { text: '❌ Reject Screenshot', callback_data: 'dep_no_' + tgId }
                      )
                    )
                  }
                });
              }
            }
          }
        }
        if (upd.callback_query) {
          const cb = upd.callback_query;
          const cbData = cb.data || '';
          const adminName = cb.from ? cb.from.first_name : 'Admin';
          const msgChatId = cb.message.chat.id;
          const msgId = cb.message.message_id;

          if (cbData.startsWith('dep_ok_')) {
            const parts = cbData.split('_');
            const targetUserId = parts.at(2);
            const creditAmt = parseFloat(parts.at(3));

            const res = await pool.query(
              'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2 RETURNING balance',
              [creditAmt, targetUserId]
            );

            if (res.rows.length > 0) {
              const updatedBal = parseFloat(res.rows.at(0).balance);
              await pool.query(
                'INSERT INTO transactions (telegram_id, type, amount, details, status) VALUES ($1, $2, $3, $4, $5)',
                [targetUserId, 'deposit', creditAmt, 'Approved by ' + adminName, 'approved']
              );

              io.to('user_' + targetUserId).emit('walletUpdate', { balance: updatedBal });

              await tgApi('sendMessage', {
                chat_id: targetUserId,
                text: '✅ *Deposit Approved!* +' + creditAmt + ' ETB has been added to your wallet.\n💰 New Balance: *' + updatedBal.toFixed(2) + ' ETB*',
                parse_mode: 'Markdown'
              });

              await tgApi('editMessageCaption', {
                chat_id: msgChatId,
                message_id: msgId,
                caption: '✅ APPROVED (+' + creditAmt + ' ETB) for User ' + targetUserId + ' by ' + adminName
              });
            }
            await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Credited +' + creditAmt + ' ETB!' });
          } else if (cbData.startsWith('dep_no_')) {
            const targetUserId = cbData.split('_').at(2);

            await tgApi('sendMessage', {
              chat_id: targetUserId,
              text: '❌ Your deposit screenshot was rejected by Admin. Please check your receipt and send a clear screenshot.'
            });

            await tgApi('editMessageCaption', {
              chat_id: msgChatId,
              message_id: msgId,
              caption: '❌ REJECTED for User ' + targetUserId + ' by ' + adminName
            });
            await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Deposit rejected.' });
          } else if (cbData.startsWith('wd_paid_')) {
            const parts = cbData.split('_');
            const txId = parts.at(2);
            const targetUserId = parts.at(3);
            const amt = parts.at(4);

            await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['paid', txId]);

            await tgApi('sendMessage', {
              chat_id: targetUserId,
              text: '✅ *Withdrawal Paid!* Your payout of *' + amt + ' ETB* (Ticket #' + txId + ') has been sent.',
              parse_mode: 'Markdown'
            });

            await tgApi('editMessageText', {
              chat_id: msgChatId,
              message_id: msgId,
              text: '✅ PAID (' + amt + ' ETB) — Ticket #' + txId + ' for User ' + targetUserId + ' (by ' + adminName + ')'
            });
            await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Marked as Paid!' });
          } else if (cbData.startsWith('wd_rej_')) {
            const parts = cbData.split('_');
            const txId = parts.at(2);
            const targetUserId = parts.at(3);
            const amt = parseFloat(parts.at(4));

            await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['rejected', txId]);
            const refRes = await pool.query(
              'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2 RETURNING balance',
              [amt, targetUserId]
            );

            const restoredBal = refRes.rows.length > 0 ? parseFloat(refRes.rows.at(0).balance) : 0;
            io.to('user_' + targetUserId).emit('walletUpdate', { balance: restoredBal });

            await tgApi('sendMessage', {
              chat_id: targetUserId,
              text: '❌ Withdrawal Ticket #' + txId + ' was rejected. *' + amt + ' ETB* has been refunded to your wallet.',
              parse_mode: 'Markdown'
            });

            await tgApi('editMessageText', {
              chat_id: msgChatId,
              message_id: msgId,
              text: '❌ REJECTED & REFUNDED (' + amt + ' ETB) — Ticket #' + txId + ' (by ' + adminName + ')'
            });
            await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Refunded ' + amt + ' ETB.' });
          }
        }
      }
    }
  } catch (e) {
  }
  setTimeout(pollTelegramUpdates, 1000);
}
pollTelegramUpdates();

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log('Kaleab Bingo server running on port ' + PORT);
});

