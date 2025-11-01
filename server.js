const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Config
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 50;
const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX = 6;

const banned = ['fuck', 'shit', 'dm', 'cc'];
let messages = [];
const messageTimestamps = new Map();

function randomAnon() {
  return 'Anon-' + Math.floor(1000 + Math.random() * 9000);
}

function sanitizeText(text) {
  let out = text;
  for (const w of banned) {
    const re = new RegExp(w, 'ig');
    out = out.replace(re, '*'.repeat(w.length));
  }
  return out;
}

// Xoá tin nhắn cũ sau TTL
setInterval(() => {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  messages = messages.filter(m => m.ts >= cutoff);
}, 30 * 60 * 1000);

app.use(express.static('public'));

// Emit số người online
function emitUserCount() {
  const count = io.sockets.sockets ? io.sockets.sockets.size : Object.keys(io.sockets.connected).length;
  io.emit('user_count', count);
}

io.on('connection', socket => {
  socket.data.name = null;
  socket.emit('ask_name');

  socket.on('set_name', name => {
    const safe = String(name || '').replace(/[\n\r]/g, '').slice(0, 30).trim();
    socket.data.name = safe || randomAnon();
    socket.emit('you_are', socket.data.name);

    const recent = messages.slice(-MAX_HISTORY);
    socket.emit('history', recent);

    socket.broadcast.emit('notice', `${socket.data.name} vừa vào phòng`);
    emitUserCount();
  });

  socket.on('send_message', text => {
    if (!socket.data.name) return;
    if (typeof text !== 'string') return;

    const now = Date.now();
    let arr = messageTimestamps.get(socket.id) || [];
    arr = arr.filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (arr.length >= RATE_LIMIT_MAX) {
      socket.emit('rate_limited', { msg: 'Bạn gửi quá nhanh, chờ chút nhé.' });
      messageTimestamps.set(socket.id, arr);
      return;
    }
    arr.push(now);
    messageTimestamps.set(socket.id, arr);

    let clean = text.trim().slice(0, 1000);
    if (!clean) return;

    clean = sanitizeText(clean);
    const msg = { id: Math.random().toString(36).slice(2, 10), name: socket.data.name, text: clean, ts: now };
    messages.push(msg);
    if (messages.length > 1000) messages.shift();

    io.emit('new_message', msg);
  });

  socket.on('change_name', newName => {
    if (!socket.data.name) return;
    const safe = String(newName || '').replace(/[\n\r]/g, '').slice(0, 30).trim();
    const old = socket.data.name;
    socket.data.name = safe || old;
    socket.emit('you_are', socket.data.name);
    socket.broadcast.emit('notice', `${old} đổi tên thành ${socket.data.name}`);
  });

  socket.on('disconnect', () => {
    if (socket.data.name)
      socket.broadcast.emit('notice', `${socket.data.name} đã rời`);
    messageTimestamps.delete(socket.id);
    emitUserCount();
  });
});

server.listen(PORT, () => {
  console.log(`✅ Anon Chat đang chạy tại: http://localhost:${PORT}`);
});
