// server.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const DB_PATH = path.join(DATA_DIR, 'chat.db');
const JWT_SECRET = process.env.JWT_SECRET || 'please_change_this_secret_now';
const DEFAULT_ADMIN_USER = 'bangbui';
const DEFAULT_ADMIN_PASS = 'ChangeMe!2025';
const ADMIN_PATH = '/admin';

const db = new sqlite3.Database(DB_PATH);

// create users table if not exists
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user'
  )`);
});

// ensure admin user exists
function ensureAdmin() {
  db.get('SELECT * FROM users WHERE username = ?', [DEFAULT_ADMIN_USER], async (err, row) => {
    if (err) return console.error('DB error checking admin:', err);
    if (!row) {
      const hash = await bcrypt.hash(DEFAULT_ADMIN_PASS, 10);
      db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [DEFAULT_ADMIN_USER, hash, 'admin'], (e) => {
        if (e) console.error('Error inserting admin:', e);
        else console.log(`Default admin created: ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASS}`);
      });
    } else {
      console.log('Admin user exists:', DEFAULT_ADMIN_USER);
    }
  });
}
ensureAdmin();

// in-memory message history & controls
let messages = []; // { id, name, text, ts, replyToId? }
const MAX_HISTORY = 500;
const mutedUntil = new Map(); // username -> timestamp(ms)
const bannedNames = new Set();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// helpers
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}
function sanitizeText(text) {
  return String(text || '').replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,9);
}

// REST: register
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Thiếu username hoặc password' });
    const uname = String(username).trim();
    if (!uname) return res.status(400).json({ error: 'Username không hợp lệ' });
    if (bannedNames.has(uname)) return res.status(403).json({ error: 'Bạn đã bị ban' });

    const hash = await bcrypt.hash(String(password), 10);
    db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [uname, hash, uname === DEFAULT_ADMIN_USER ? 'admin' : 'user'], function(err) {
      if (err) return res.status(400).json({ error: 'Username đã tồn tại' });
      return res.json({ success: true, message: 'Đăng ký thành công' });
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Lỗi server' });
  }
});

// REST: login
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu username hoặc password' });
  const uname = String(username).trim();
  db.get('SELECT id, username, password, role FROM users WHERE username = ?', [uname], async (err, row) => {
    if (err) return res.status(500).json({ error: 'Lỗi server' });
    if (!row) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    const ok = await bcrypt.compare(String(password), row.password);
    if (!ok) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    const token = signToken({ id: row.id, username: row.username, role: row.role });
    return res.json({ success: true, token, role: row.role, username: row.username });
  });
});

// Admin-only: list users (no passwords)
app.get('/admin/users', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Unauthorized' });
  const token = parts[1];
  const info = verifyToken(token);
  if (!info || info.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  db.all('SELECT id, username, role FROM users ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    return res.json({ users: rows });
  });
});

// Admin-only: delete user from DB
app.delete('/admin/user/:username', (req, res) => {
  const auth = req.headers.authorization;
  const parts = (auth || '').split(' ');
  const token = parts[1];
  const info = verifyToken(token);
  if (!info || info.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const target = req.params.username;
  db.run('DELETE FROM users WHERE username = ?', [target], function (err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    return res.json({ success: true });
  });
});

// serve admin path file (admin.html) from /public - client will check token
app.get(ADMIN_PATH, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- Socket.io ---
io.on('connection', (socket) => {
  socket.data.user = null;

  // send history helper
  function sendHistory(sock) {
    const rec = messages.slice(-MAX_HISTORY);
    (sock || socket).emit('history', rec);
  }

  socket.on('authenticate', (obj) => {
    const token = obj && obj.token;
    const info = verifyToken(token);
    if (!info) {
      socket.emit('auth_failed');
      return;
    }
    if (bannedNames.has(info.username)) {
      socket.emit('auth_banned');
      socket.disconnect(true);
      return;
    }
    socket.data.user = { id: info.id, username: info.username, role: info.role };
    socket.join('chatroom');
    socket.emit('auth_ok', { username: info.username, role: info.role });
    sendHistory(socket);
    io.to('chatroom').emit('notice', `${info.username} vừa vào phòng`);
    emitUserCount();
  });

  socket.on('send_message', (text) => {
    if (!socket.data.user) return socket.emit('notice', 'Bạn chưa đăng nhập.');
    const uname = socket.data.user.username;
    // mute check
    const mu = mutedUntil.get(uname);
    if (mu && mu > Date.now()) return socket.emit('notice', 'Bạn đang bị khóa gửi trong 1 thời gian.');
    const clean = sanitizeText(String(text || '')).slice(0, 1000).trim();
    if (!clean) return;
    // if reply format: client will include replyToId in message string? we'll allow client to send object optionally
    // support if client sends object { text, replyToId }
    let replyToId = null;
    let finalText = clean;
    try {
      // allow structured message: client might send JSON string
      if (typeof text === 'object' && text !== null) {
        finalText = sanitizeText(String(text.text || '')).slice(0,1000);
        replyToId = text.replyToId || null;
      }
    } catch (e) {}
    const msg = { id: genId(), name: uname, text: finalText, ts: Date.now(), replyToId: replyToId || null };
    messages.push(msg);
    if (messages.length > 2000) messages.shift();
    io.to('chatroom').emit('new_message', msg);
  });

  // admin socket actions (server verifies role via socket.data.user)
  socket.on('delete_message', (id) => {
    if (!socket.data.user || socket.data.user.role !== 'admin') return socket.emit('notice', 'Không có quyền');
    const idx = messages.findIndex(m => m.id === id);
    if (idx !== -1) {
      messages.splice(idx, 1);
      io.to('chatroom').emit('message_deleted', id);
    }
  });

  socket.on('kick_user', (targetUsername) => {
    if (!socket.data.user || socket.data.user.role !== 'admin') return socket.emit('notice', 'Không có quyền');
    for (const [sId, s] of io.sockets.sockets.entries()) {
      if (s.data && s.data.user && s.data.user.username === targetUsername) {
        s.emit('notice', 'Bạn đã bị admin đá khỏi phòng.');
        s.disconnect(true);
        io.to('chatroom').emit('notice', `${targetUsername} đã bị admin đá.`);
        break;
      }
    }
    emitUserCount();
  });

  socket.on('mute_user', ({ name, seconds }) => {
    if (!socket.data.user || socket.data.user.role !== 'admin') return socket.emit('notice', 'Không có quyền');
    const until = Date.now() + (Number(seconds) || 60) * 1000;
    mutedUntil.set(name, until);
    io.to('chatroom').emit('notice', `${name} bị khóa gửi trong ${seconds} giây (bởi admin)`);
  });

  socket.on('ban_user', (name) => {
    if (!socket.data.user || socket.data.user.role !== 'admin') return socket.emit('notice', 'Không có quyền');
    bannedNames.add(name);
    for (const [sId, s] of io.sockets.sockets.entries()) {
      if (s.data && s.data.user && s.data.user.username === name) {
        s.emit('notice', 'Bạn đã bị ban.');
        s.disconnect(true);
        break;
      }
    }
    io.to('chatroom').emit('notice', `${name} đã bị ban`);
    emitUserCount();
  });

  socket.on('clear_history', () => {
    if (!socket.data.user || socket.data.user.role !== 'admin') return socket.emit('notice', 'Không có quyền');
    messages = [];
    io.to('chatroom').emit('history_cleared');
    io.to('chatroom').emit('notice', 'Lịch sử đã bị xóa bởi admin');
  });

  socket.on('admin_notice', (txt) => {
    if (!socket.data.user || socket.data.user.role !== 'admin') return socket.emit('notice', 'Không có quyền');
    const safe = sanitizeText(String(txt || '')).slice(0, 300);
    io.to('chatroom').emit('notice', `[ADMIN] ${safe}`);
  });

  socket.on('request_user_list', () => {
    // send list of connected users (usernames)
    const users = Array.from(io.sockets.sockets.values())
      .filter(s => s.data && s.data.user)
      .map(s => s.data.user.username);
    socket.emit('user_list', users);
  });

  function emitUserCount() {
    const count = Array.from(io.sockets.sockets.values()).filter(s => s.data && s.data.user).length;
    io.to('chatroom').emit('user_count', count);
  }

  socket.on('disconnect', () => {
    if (socket.data.user) {
      io.to('chatroom').emit('notice', `${socket.data.user.username} đã rời`);
      emitUserCount();
    }
  });
});

// Listen
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Anon Chat server running at http://localhost:${PORT}`);
  console.log(`Admin username: ${DEFAULT_ADMIN_USER}  (default password: ${DEFAULT_ADMIN_PASS})`);
  console.log(`Change JWT_SECRET env var before public deploy!`);
});
