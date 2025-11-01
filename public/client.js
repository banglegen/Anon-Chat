// public/client.js
const socket = io();

const messagesEl = document.getElementById('messages');
const form = document.getElementById('form');
const input = document.getElementById('input');
const myNameEl = document.getElementById('myName');
const noticeArea = document.getElementById('noticeArea');
const changeNameBtn = document.getElementById('changeNameBtn');
const userCountEl = document.getElementById('userCount');
const goAdminBtn = document.getElementById('goAdminBtn');

let myName = localStorage.getItem('anon_user') || null;
let myRole = localStorage.getItem('anon_role') || null;
let token = localStorage.getItem('anon_token') || null;
let replyTo = null; // { id, name } when replying

if (!token || !myName) {
  location.href = '/';
} else {
  myNameEl.textContent = `Bạn: ${myName}`;
  if (myRole === 'admin') goAdminBtn.style.display = 'inline-block';
  socket.emit('authenticate', { token });
}

socket.on('auth_ok', (info) => {
  addNotice(`Xin chào ${info.username}`);
});

socket.on('auth_failed', () => {
  addNotice('Xác thực thất bại. Vui lòng đăng nhập lại.');
  localStorage.removeItem('anon_token');
  setTimeout(() => location.href = '/', 1000);
});

socket.on('auth_banned', () => {
  addNotice('Bạn đã bị ban.');
  setTimeout(() => location.href = '/', 1000);
});

socket.on('history', arr => {
  messagesEl.innerHTML = '';
  arr.forEach(addMessage);
});

socket.on('new_message', msg => addMessage(msg));
socket.on('message_deleted', id => {
  const el = document.querySelector(`li.message[data-id="${id}"]`);
  if (el) el.remove();
});
socket.on('history_cleared', () => { messagesEl.innerHTML = ''; });
socket.on('user_count', n => { userCountEl.textContent = `👥 ${n} người đang trong phòng`; });
socket.on('notice', t => addNotice(t));

// submit
form.addEventListener('submit', e => {
  e.preventDefault();
  if (!token) return addNotice('Bạn chưa đăng nhập.');
  const val = input.value;
  if (!val || !val.trim()) return;
  // send object with replyToId if replying
  const payload = replyTo ? { text: val, replyToId: replyTo.id } : { text: val };
  socket.emit('send_message', payload);
  input.value = '';
  replyTo = null;
});

// shift+enter vs enter
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (!e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  }
});

// change local display name (client-side only)
changeNameBtn.addEventListener('click', () => {
  const newName = prompt('Nhập tên mới (tối đa 30 ký tự):');
  if (!newName) return;
  myName = newName.slice(0,30);
  localStorage.setItem('anon_user', myName);
  myNameEl.textContent = `Bạn: ${myName}`;
  addNotice('Bạn đã đổi tên hiển thị (chỉ trên client)');
});

// go admin
if (goAdminBtn) goAdminBtn.addEventListener('click', () => { location.href = '/admin'; });

// click to reply (use message id)
messagesEl.addEventListener('click', e => {
  const li = e.target.closest('li.message');
  if (!li) return;
  const name = li.dataset.name;
  const id = li.dataset.id;
  if (!name || name === myName) return;
  replyTo = { id, name };
  input.value = `@${name}: `;
  input.focus();
});

function addMessage(msg) {
  const li = document.createElement('li');
  li.className = msg.name === myName ? 'message me' : 'message';
  li.dataset.id = msg.id;
  li.dataset.name = msg.name;
  const date = new Date(msg.ts);
  let replyHTML = '';
  let textContent = msg.text;
  if (msg.replyToId) {
    // try to find original message name from DOM or history
    const original = document.querySelector(`li.message[data-id="${msg.replyToId}"]`);
    const origName = original ? original.dataset.name : '...';
    replyHTML = `<div class="replyTo">↪ ${escapeHtml(origName)}</div>`;
  }
  // admin controls for client? Only admin will open admin.html; in chat we won't show admin buttons to keep UI clean.
  li.innerHTML = `<div class="meta"><strong>${escapeHtml(msg.name)}</strong> • ${date.toLocaleTimeString()}</div>
                  ${replyHTML}
                  <div class="msgText">${escapeHtml(textContent)}</div>`;
  messagesEl.appendChild(li);
  messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
}

function addNotice(text) {
  noticeArea.textContent = text;
  setTimeout(() => { if (noticeArea.textContent === text) noticeArea.textContent = ''; }, 4000);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
