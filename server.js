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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
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

function buildUserList() {
  return Object.keys(users).map(n => ({
    name: n, color: users[n].color || '#1d6bf0',
    online: Array.from(sessions.values()).some(s => s.name === n),
    avatar: users[n].avatar || '',
    bio: users[n].bio || '',
  }));
}

function getConvForUser(convId, username) {
  const c = conversations[convId];
  if (!c) return null;
  if (c.type === 'dm' && !c.participants.includes(username)) return null;
  if (c.type === 'group' && !c.members.includes(username)) return null;
  return c;
}

wss.on('connection', (ws) => {
  let session = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data.type) return;

    switch (data.type) {

      // ============ AUTH ============
      case 'register': {
        const { username, password } = data;
        if (!username || !password || username.length < 2 || password.length < 3) {
          send(ws, { type: 'error', message: 'Имя от 2 символов, пароль от 3' }); return;
        }
        if (users[username]) { send(ws, { type: 'error', message: 'Имя занято' }); return; }
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

        send(ws, {
          type: 'login_ok', user: username,
          users: buildUserList(), online: sessions.size,
          profile: { name: username, bio: u.bio || '', color: u.color || '#1d6bf0', avatar: u.avatar || '' },
        });
        broadcast({ type: 'user_online', name: username, users: buildUserList(), online: sessions.size }, ws);
        break;
      }

      // ============ PROFILE ============
      case 'profile_update': {
        if (!session) return;
        const u = users[session.name];
        if (!u) return;
        if (data.bio !== undefined) u.bio = data.bio.slice(0, 200);
        if (data.color !== undefined) u.color = data.color;
        if (data.avatar !== undefined) u.avatar = data.avatar;
        saveUsers();
        broadcast({ type: 'profile_updated', name: session.name, profile: { name: session.name, bio: u.bio || '', color: u.color || '#1d6bf0', avatar: u.avatar || '' } });
        break;
      }

      // ============ USERS ============
      case 'get_users': {
        if (!session) return;
        send(ws, { type: 'users_list', users: buildUserList() });
        break;
      }

      // ============ CONVERSATIONS ============
      case 'start_dm': {
        if (!session) return;
        const target = (data.target || '').trim();
        if (!target || !users[target]) { send(ws, { type: 'error', message: 'Пользователь не найден' }); return; }
        if (target === session.name) { send(ws, { type: 'error', message: 'Нельзя с собой' }); return; }
        const convId = [session.name, target].sort().join('::');
        if (!conversations[convId]) {
          conversations[convId] = {
            id: convId, type: 'dm', participants: [session.name, target], created: Date.now(),
          };
          saveConvs();
        }
        send(ws, { type: 'dm_created', conversation: conversations[convId] });
        break;
      }

      case 'create_group': {
        if (!session) return;
        const name = (data.name || '').trim().slice(0, 30);
        if (!name) { send(ws, { type: 'error', message: 'Введите название группы' }); return; }
        const members = data.members || [];
        if (!members.includes(session.name)) members.unshift(session.name);
        if (members.length < 2) { send(ws, { type: 'error', message: 'Нужно минимум 2 участника' }); return; }
        const convId = 'g_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        conversations[convId] = {
          id: convId, type: 'group', name, members, creator: session.name, created: Date.now(),
        };
        saveConvs();
        // System message
        const sysMsg = { id: 'sys_' + Date.now(), from: 'system', text: `Группа "${name}" создана`, time: new Date().toISOString(), convId, system: true };
        if (!messages[convId]) messages[convId] = [];
        messages[convId].push(sysMsg);
        saveMsgs();
        // Notify all members
        for (const [client, s] of sessions) {
          if (members.includes(s.name) && client.readyState === 1) {
            send(client, { type: 'group_created', conversation: conversations[convId] });
          }
        }
        break;
      }

      case 'add_to_group': {
        if (!session) return;
        const convId = data.convId;
        const conv = conversations[convId];
        if (!conv || conv.type !== 'group') { send(ws, { type: 'error', message: 'Группа не найдена' }); return; }
        if (!conv.members.includes(session.name)) { send(ws, { type: 'error', message: 'Вы не в группе' }); return; }
        const target = (data.target || '').trim();
        if (!target || !users[target]) { send(ws, { type: 'error', message: 'Пользователь не найден' }); return; }
        if (conv.members.includes(target)) { send(ws, { type: 'error', message: 'Уже в группе' }); return; }
        conv.members.push(target);
        saveConvs();
        const sysMsg = { id: 'sys_' + Date.now(), from: 'system', text: `${session.name} добавил(а) ${target}`, time: new Date().toISOString(), convId, system: true };
        if (!messages[convId]) messages[convId] = [];
        messages[convId].push(sysMsg);
        saveMsgs();
        for (const [client, s] of sessions) {
          if (conv.members.includes(s.name) && client.readyState === 1) {
            send(client, { type: 'group_updated', conversation: conv });
            send(client, { type: 'new_msg', message: sysMsg });
          }
        }
        break;
      }

      case 'get_convs': {
        if (!session) return;
        const myConvs = Object.values(conversations).filter(c => {
          if (c.type === 'dm' && c.participants.includes(session.name)) return true;
          if (c.type === 'group' && c.members.includes(session.name)) return true;
          return false;
        });
        send(ws, { type: 'convs_list', conversations: myConvs });
        break;
      }

      case 'get_conv_info': {
        if (!session) return;
        const conv = getConvForUser(data.convId, session.name);
        if (!conv) { send(ws, { type: 'error', message: 'Нет доступа' }); return; }
        if (conv.type === 'group') {
          const membersInfo = conv.members.map(n => ({
            name: n, ...(users[n] ? { color: users[n].color, avatar: users[n].avatar, bio: users[n].bio, online: Array.from(sessions.values()).some(s => s.name === n) } : {}),
          }));
          send(ws, { type: 'conv_info', conversation: conv, members: membersInfo });
        } else {
          send(ws, { type: 'conv_info', conversation: conv });
        }
        break;
      }

      // ============ MESSAGES ============
      case 'get_messages': {
        if (!session) return;
        const convId = data.convId;
        if (!convId) return;
        if (!getConvForUser(convId, session.name)) return;
        const msgs = (messages[convId] || []).slice(-200);
        send(ws, { type: 'msgs_list', convId, messages: msgs });
        break;
      }

      case 'send_msg': {
        if (!session) return;
        const text = (data.text || '').trim();
        if (!text) return;

        const msg = {
          id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          from: session.name, text, time: new Date().toISOString(),
        };

        if (data.convId) {
          const conv = getConvForUser(data.convId, session.name);
          if (!conv) return;
          msg.convId = data.convId;
          if (!messages[data.convId]) messages[data.convId] = [];
          messages[data.convId].push(msg);
          if (messages[data.convId].length > 200) messages[data.convId] = messages[data.convId].slice(-200);
          saveMsgs();
          const targets = conv.type === 'dm' ? conv.participants : conv.members;
          for (const [client, s] of sessions) {
            if (targets.includes(s.name) && client.readyState === 1) {
              send(client, { type: 'new_msg', message: msg });
            }
          }
        } else {
          broadcast({ type: 'new_msg', message: msg });
        }
        break;
      }

      // ============ TYPING ============
      case 'typing': {
        if (!session) return;
        broadcast({ type: 'typing', name: session.name, convId: data.convId }, ws);
        break;
      }

      // ============ REACTIONS ============
      case 'reaction': {
        if (!session) return;
        broadcast({ type: 'reaction', name: session.name, msgId: data.msgId, reaction: data.reaction, convId: data.convId });
        break;
      }

      // ============ CALLS (WebRTC) ============
      case 'call_user': {
        if (!session) return;
        const target = (data.target || '').trim();
        if (!target || !users[target]) return;
        const callerName = session.name;
        // Forward call to target
        for (const [client, s] of sessions) {
          if (s.name === target && client.readyState === 1) {
            send(client, { type: 'incoming_call', from: callerName, video: !!data.video });
            send(ws, { type: 'call_ringing', target });
            return;
          }
        }
        send(ws, { type: 'error', message: 'Пользователь не в сети' });
        break;
      }

      case 'call_accept': {
        if (!session) return;
        const target = (data.target || '').trim();
        for (const [client, s] of sessions) {
          if (s.name === target && client.readyState === 1) {
            send(client, { type: 'call_accepted', from: session.name });
            break;
          }
        }
        break;
      }

      case 'call_reject': {
        if (!session) return;
        const target = (data.target || '').trim();
        for (const [client, s] of sessions) {
          if (s.name === target && client.readyState === 1) {
            send(client, { type: 'call_rejected', from: session.name });
            break;
          }
        }
        break;
      }

      case 'call_end': {
        if (!session) return;
        const target = (data.target || '').trim();
        for (const [client, s] of sessions) {
          if (s.name === target && client.readyState === 1) {
            send(client, { type: 'call_ended', from: session.name });
            break;
          }
        }
        break;
      }

      case 'offer': case 'answer': case 'ice_candidate': {
        if (!session) return;
        const target = data.target;
        if (!target) return;
        for (const [client, s] of sessions) {
          if (s.name === target && client.readyState === 1) {
            send(client, { type: data.type, from: session.name, data: data.data });
            break;
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (session) {
      if (users[session.name]) users[session.name].lastSeen = Date.now();
      saveUsers();
      sessions.delete(ws);
      broadcast({ type: 'user_offline', name: session.name, users: buildUserList(), online: sessions.size });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✦ Poins Messenger запущен на порту ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
});
