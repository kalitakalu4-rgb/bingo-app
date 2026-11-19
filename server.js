const express = require('express');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let takenCartelas = {};

io.on('connection', (socket) => {
  socket.emit('lobbyUpdate', takenCartelas);

  socket.on('selectCartela', (cartelaNum) => {
    if (cartelaNum >= 1 && cartelaNum <= 100 && !takenCartelas[cartelaNum]) {
      for (const [num, id] of Object.entries(takenCartelas)) {
        if (id === socket.id) delete takenCartelas[num];
      }
      takenCartelas[cartelaNum] = socket.id;
      socket.emit('cartelaConfirmed', cartelaNum);
      io.emit('lobbyUpdate', takenCartelas);
    }
  });

  socket.on('disconnect', () => {
    let changed = false;
    for (const [num, id] of Object.entries(takenCartelas)) {
      if (id === socket.id) {
        delete takenCartelas[num];
        changed = true;
      }
    }
    if (changed) io.emit('lobbyUpdate', takenCartelas);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Bingo server running on port ${PORT}`);
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

