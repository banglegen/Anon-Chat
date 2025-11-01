const socket = io();

const messagesEl = document.getElementById('messages');
const form = document.getElementById('form');
const input = document.getElementById('input');
const myNameEl = document.getElementById('myName');
const noticeArea = document.getElementById('noticeArea');
const changeNameBtn = document.getElementById('changeNameBtn');
const userCountEl = document.getElementById('userCount');

let replyTo = null; // lưu tên người đang reply

// Kiểm tra kết nối
socket.on('connect', () => console.log('✅ Connected to server', socket.id));
socket.on('disconnect', () => console.log('❌ Disconnected from server'));

// Hỏi tên khi kết nối
socket.on('ask_name', () => {
  let name = '';
  while (true) {
    name = prompt('Nhập tên ẩn danh của bạn (tối đa 30 ký tự, để trống để ngẫu nhiên):') || '';
    if (name.length <= 30) break;
    alert('Tên quá dài, thử lại nhé.');
  }
  socket.emit('set_name', name);
});

// Hiển thị tên của bạn
socket.on('you_are', name => {
  myNameEl.textContent = `Bạn: ${name}`;
});

// Hiển thị lịch sử tin nhắn
socket.on('history', arr => {
  messagesEl.innerHTML = '';
  arr.forEach(addMessage);
});

// Tin nhắn mới
socket.on('new_message', msg => addMessage(msg));

// Thông báo
socket.on('notice', t => addNotice(t));

// Rate limit
socket.on('rate_limited', obj => addNotice(obj.msg || 'Bạn gửi quá nhanh.'));

// Số người online
socket.on('user_count', count => {
  userCountEl.textContent = `👥 ${count} người đang trong phòng`;
});

// Click vào tin nhắn để reply
messagesEl.addEventListener('click', e => {
  const li = e.target.closest('li.message');
  if (!li) return;

  const nameEl = li.querySelector('.meta strong');
  if (!nameEl) return;

  const name = nameEl.textContent;
  if (name === myNameEl.textContent.split(': ')[1]) return; // không reply chính mình

  replyTo = name;
  input.value = `@${name}: `;
  input.focus();
});

// Gửi tin nhắn
form.addEventListener('submit', e => {
  e.preventDefault();
  let val = input.value.trim();
  if (!val) return;

  socket.emit('send_message', val);
  input.value = '';
  input.style.height = 'auto';
  replyTo = null;
});

// Shift+Enter xuống dòng, Enter gửi
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (!e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  }
});

// Đổi tên
changeNameBtn.addEventListener('click', () => {
  const newName = prompt('Nhập tên mới (tối đa 30 ký tự):') || '';
  socket.emit('change_name', newName);
});

// Thêm tin nhắn vào chat
function addMessage(msg) {
  const li = document.createElement('li');
  li.className = msg.name === myNameEl.textContent.split(': ')[1] ? 'message me' : 'message';
  const date = new Date(msg.ts);

  // Kiểm tra reply format @Tên:
  let replyHTML = '';
  let textContent = msg.text;
  const match = msg.text.match(/^@([^:\s]+):\s(.+)/);
  if (match) {
    const repliedName = match[1];
    textContent = match[2];
    replyHTML = `<div class="replyTo">↪ ${escapeHtml(repliedName)}</div>`;
  }

  li.innerHTML = `<div class="meta"><strong>${escapeHtml(msg.name)}</strong> • ${date.toLocaleTimeString()}</div>
                  ${replyHTML}
                  <div class="msgText">${escapeHtml(textContent)}</div>`;
  messagesEl.appendChild(li);
  messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
}

// Hiển thị thông báo nhỏ
function addNotice(text) {
  noticeArea.textContent = text;
  setTimeout(() => {
    if (noticeArea.textContent === text) noticeArea.textContent = '';
  }, 4000);
}

// Escape HTML để tránh XSS
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
