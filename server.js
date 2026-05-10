const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONVS_FILE = path.join(DATA_DIR, 'conversations.json');
const MSGS_FILE = path.join(DATA_DIR, 'messages.json');

function loadJSON(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let users = loadJSON(USERS_FILE);
let conversations = loadJSON(CONVS_FILE);
let messages = loadJSON(MSGS_FILE);

function saveUsers() { saveJSON(USERS_FILE, users); }
function saveConvs() { saveJSON(CONVS_FILE, conversations); }
function saveMsgs() { saveJSON(MSGS_FILE, messages); }

function hash(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

const sessions = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function broadcast(data, exclude) {
  const msg = JSON.stringify(data);
  for (const [ws] of sessions) {
    if (ws !== exclude && ws.readyState === 1) ws.send(msg);
  }
}
function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function onlineList() {
  return Array.from(sessions.values()).map(s => ({
    name: s.name,
    color: (users[s.name] || {}).color || '#1d6bf0',
  }));
}

wss.on('connection', (ws) => {
  let session = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data.type) return;

    switch (data.type) {

      // ---- AUTH ----
      case 'register': {
        const { username, password } = data;
        if (!username || !password || username.length < 2 || password.length < 3) {
          send(ws, { type: 'error', message: 'Имя от 2 символов, пароль от 3' }); return;
        }
        if (users[username]) { send(ws, { type: 'error', message: 'Имя уже занято' }); return; }
        users[username] = {
          password: hash(password), role: 'user',
          bio: '', color: '#1d6bf0', avatar: '',
          created: Date.now(), lastSeen: Date.now(),
        };
        saveUsers();
        send(ws, { type: 'register_ok' });
        break;
      }

      case 'login': {
        const { username, password } = data;
        const u = users[username];
        if (!u || u.password !== hash(password)) {
          send(ws, { type: 'error', message: 'Неверное имя или пароль' }); return;
        }
        u.lastSeen = Date.now();
        saveUsers();
        session = { name: username };
        sessions.set(ws, session);

        const allUsers = Object.keys(users).map(n => ({
          name: n, color: users[n].color || '#1d6bf0',
          online: Array.from(sessions.values()).some(s => s.name === n),
          lastSeen: users[n].lastSeen || 0,
        }));

        send(ws, {
          type: 'login_ok', user: username,
          users: allUsers, online: sessions.size,
          profile: { name: username, ...u, password: undefined },
        });
        broadcast({ type: 'user_online', name: username, users: onlineList(), online: sessions.size }, ws);
        break;
      }

      // ---- PROFILE ----
      case 'profile_update': {
        if (!session) return;
        const u = users[session.name];
        if (!u) return;
        if (data.bio !== undefined) u.bio = data.bio.slice(0, 200);
        if (data.color !== undefined) u.color = data.color;
        saveUsers();
        broadcast({ type: 'profile_updated', name: session.name, color: u.color, bio: u.bio });
        break;
      }

      // ---- USERS ----
      case 'get_users': {
        if (!session) return;
        const all = Object.keys(users).map(n => ({
          name: n, color: users[n].color || '#1d6bf0',
          online: Array.from(sessions.values()).some(s => s.name === n),
        }));
        send(ws, { type: 'users_list', users: all });
        break;
      }

      // ---- CONVERSATIONS (DM) ----
      case 'start_dm': {
        if (!session) return;
        const target = (data.target || '').trim();
        if (!target || !users[target]) { send(ws, { type: 'error', message: 'Пользователь не найден' }); return; }
        if (target === session.name) { send(ws, { type: 'error', message: 'Нельзя с собой' }); return; }
        const convId = [session.name, target].sort().join('::');
        if (!conversations[convId]) {
          conversations[convId] = {
            id: convId, type: 'dm',
            participants: [session.name, target],
            created: Date.now(),
          };
          saveConvs();
        }
        send(ws, { type: 'dm_created', conversation: conversations[convId] });
        break;
      }

      case 'get_convs': {
        if (!session) return;
        const myConvs = Object.values(conversations).filter(c => c.participants.includes(session.name));
        send(ws, { type: 'convs_list', conversations: myConvs });
        break;
      }

      // ---- MESSAGES ----
      case 'get_messages': {
        if (!session) return;
        const convId = data.convId;
        if (!convId) return;
        const conv = conversations[convId];
        if (!conv || !conv.participants.includes(session.name)) return;
        const msgs = (messages[convId] || []).slice(-100);
        send(ws, { type: 'msgs_list', convId, messages: msgs });
        break;
      }

      case 'send_msg': {
        if (!session) return;
        const text = (data.text || '').trim();
        if (!text) return;

        if (data.convId) {
          // DM
          const conv = conversations[data.convId];
          if (!conv || !conv.participants.includes(session.name)) return;
          const msg = {
            id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            from: session.name, text, time: new Date().toISOString(), convId: data.convId,
          };
          if (!messages[data.convId]) messages[data.convId] = [];
          messages[data.convId].push(msg);
          if (messages[data.convId].length > 200) messages[data.convId] = messages[data.convId].slice(-200);
          saveMsgs();
          for (const [client, s] of sessions) {
            if (conv.participants.includes(s.name) && client.readyState === 1) {
              send(client, { type: 'new_msg', message: msg });
            }
          }
        } else {
          // Main chat
          const msg = {
            id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            from: session.name, text, time: new Date().toISOString(),
          };
          broadcast({ type: 'new_msg', message: msg });
        }
        break;
      }

      // ---- TYPING ----
      case 'typing': {
        if (!session) return;
        broadcast({ type: 'typing', name: session.name, convId: data.convId }, ws);
        break;
      }

      // ---- REACTIONS ----
      case 'reaction': {
        if (!session) return;
        broadcast({ type: 'reaction', name: session.name, msgId: data.msgId, reaction: data.reaction, convId: data.convId });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (session) {
      if (users[session.name]) users[session.name].lastSeen = Date.now();
      saveUsers();
      sessions.delete(ws);
      broadcast({ type: 'user_offline', name: session.name, users: onlineList(), online: sessions.size });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✦ Poins Messenger запущен на порту ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
});
