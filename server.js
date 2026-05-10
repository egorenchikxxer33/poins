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
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

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

function hash(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function genID(len) { return crypto.randomBytes(len).toString('hex'); }

// Premium keys
let premiumKeys = loadJSON(KEYS_FILE);
if (!premiumKeys || !premiumKeys.keys || !premiumKeys.keys.length) {
  const keys = [];
  for (let i = 0; i < 10; i++) {
    keys.push({ code: genID(6), durationMs: 10 * 24 * 60 * 60 * 1000, used: false, usedBy: null, usedAt: null });
  }
  premiumKeys = { keys };
  saveJSON(KEYS_FILE, premiumKeys);
  console.log(`  🔑 Сгенерировано ${keys.length} премиум-ключей:`);
  keys.forEach(k => console.log(`     ${k.code}`));
}

const sessions = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  if (req.url === '/admin/keys' && req.method === 'GET') {
    const list = (premiumKeys.keys || []).map(k => ({ code: k.code, used: k.used, usedBy: k.usedBy || null, usedAt: k.usedAt || null }));
    const active = list.filter(k => !k.used);
    const used = list.filter(k => k.used);
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Poins Keys</title><style>body{font-family:monospace;background:#0b0e17;color:#e8edf3;padding:40px;max-width:600px;margin:0 auto}h1{color:#1d6bf0}.key{background:#141d2b;padding:10px 16px;border-radius:8px;margin:6px 0;display:flex;justify-content:space-between;align-items:center;border:1px solid rgba(255,255,255,.06)}.key .c{font-size:16px;letter-spacing:2px;font-weight:600}.key .s{font-size:11px;color:#4a5a6e}.used{opacity:.4;text-decoration:line-through}.badge{font-size:10px;padding:3px 8px;border-radius:4px}.badge-ok{background:#2ecc71;color:#fff}.badge-used{background:#e74c4c;color:#fff}h2{color:#8a98aa;font-size:14px;margin-top:24px;text-transform:uppercase;letter-spacing:1px}</style></head><body><h1>🔑 Poins Premium Keys</h1><h2>Available (${active.length})</h2>${active.map(k=>`<div class="key"><span class="c">${k.code}</span><span class="badge badge-ok">FREE</span></div>`).join('')}<h2>Used (${used.length})</h2>${used.map(k=>`<div class="key used"><span class="c">${k.code}</span><span class="s">→ ${k.usedBy} (${k.usedAt})</span></div>`).join('')}</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
  }
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
  for (const [ws] of sessions) { if (ws !== exclude && ws.readyState === 1) ws.send(msg); }
}
function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }

function buildUserList() {
  return Object.keys(users).map(n => {
    const u = users[n];
    const showOnline = u.invisible ? false : Array.from(sessions.values()).some(s => s.name === n);
    return { name: n, color: u.color || '#1d6bf0', online: showOnline, avatar: u.avatar || '', bio: u.bio || '', premium: !!u.premium, emojiStatus: u.emojiStatus || '' };
  });
}

function getConvForUser(convId, username) {
  const c = conversations[convId]; if (!c) return null;
  if (c.type === 'dm' && !c.participants.includes(username)) return null;
  if (c.type === 'group' && !c.members.includes(username)) return null;
  return c;
}

function isBlocked(target, by) { const u = users[by]; return u && u.blocked && u.blocked.includes(target); }
function msgTargets(conv) { return conv.type === 'dm' ? conv.participants : conv.members; }

function userProfile(name) {
  const u = users[name]; if (!u) return { name };
  return { name, bio: u.bio || '', color: u.color || '#1d6bf0', avatar: u.avatar || '', premium: !!u.premium, emojiStatus: u.emojiStatus || '', theme: u.theme || 'midnight', bgImage: u.bgImage || '', nameColor: u.nameColor || '', premiumUntil: u.premiumUntil || null };
}

function sendToConv(conv, data, excludeWs) {
  const targets = msgTargets(conv);
  for (const [client, s] of sessions) { if (s && targets.includes(s.name) && client !== excludeWs && client.readyState === 1) send(client, data); }
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
        if (!username || !password || username.length < 2 || password.length < 3) { send(ws, { type: 'error', message: 'Имя от 2 символов, пароль от 3' }); return; }
        if (users[username]) { send(ws, { type: 'error', message: 'Имя занято' }); return; }
        users[username] = { password: hash(password), role: 'user', bio: '', color: '#1d6bf0', avatar: '', premium: false, emojiStatus: '', theme: 'midnight', bgImage: '', nameColor: '', stickers: [], blocked: [], invisible: false, created: Date.now(), lastSeen: Date.now() };
        saveUsers();
        send(ws, { type: 'register_ok' });
        break;
      }

      case 'login': {
        const { username, password } = data;
        const u = users[username];
        if (!u || u.password !== hash(password)) { send(ws, { type: 'error', message: 'Неверное имя или пароль' }); return; }
        u.lastSeen = Date.now(); saveUsers();
        session = { name: username }; sessions.set(ws, session);
        send(ws, { type: 'login_ok', user: username, users: buildUserList(), online: sessions.size, profile: userProfile(username) });
        broadcast({ type: 'user_online', name: username, users: buildUserList(), online: sessions.size }, ws);
        break;
      }

      case 'change_password': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (!data.oldPassword || !data.newPassword || data.newPassword.length < 3) { send(ws, { type: 'error', message: 'Старый пароль или новый (мин 3 символа)' }); return; }
        if (u.password !== hash(data.oldPassword)) { send(ws, { type: 'error', message: 'Неверный старый пароль' }); return; }
        u.password = hash(data.newPassword); saveUsers();
        send(ws, { type: 'password_changed' });
        break;
      }

      case 'delete_account': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (!data.password || u.password !== hash(data.password)) { send(ws, { type: 'error', message: 'Неверный пароль' }); return; }
        delete users[session.name]; saveUsers();
        sessions.delete(ws);
        broadcast({ type: 'user_offline', name: session.name, users: buildUserList(), online: sessions.size });
        send(ws, { type: 'account_deleted' });
        session = null;
        break;
      }

      // ============ PROFILE ============
      case 'profile_update': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (data.bio !== undefined) u.bio = data.bio.slice(0, 200);
        if (data.color !== undefined) u.color = data.color;
        if (data.avatar !== undefined) u.avatar = data.avatar;
        if (data.nameColor !== undefined) u.nameColor = data.nameColor;
        if (data.invisible !== undefined) u.invisible = !!data.invisible;
        saveUsers();
        broadcast({ type: 'profile_updated', name: session.name, profile: userProfile(session.name) });
        break;
      }

      // ============ PREMIUM ============
      case 'premium_activate': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (!data.code || !data.code.trim()) { send(ws, { type: 'error', message: 'Введите код' }); return; }
        const code = data.code.trim().toLowerCase();
        const key = premiumKeys.keys.find(k => k.code === code && !k.used);
        if (!key) { send(ws, { type: 'error', message: 'Неверный или уже использованный ключ' }); return; }
        key.used = true; key.usedBy = session.name; key.usedAt = new Date().toISOString();
        u.premium = true; u.premiumUntil = Date.now() + key.durationMs;
        saveJSON(KEYS_FILE, premiumKeys); saveUsers();
        send(ws, { type: 'premium_activated', until: u.premiumUntil });
        broadcast({ type: 'profile_updated', name: session.name, profile: userProfile(session.name) });
        break;
      }

      case 'set_emoji_status': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        u.emojiStatus = (data.status || '').slice(0, 4); saveUsers();
        broadcast({ type: 'profile_updated', name: session.name, profile: userProfile(session.name) });
        break;
      }

      case 'set_theme': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        const themes = ['midnight','sakura','forest','ocean','sunset','cyberpunk','nord'];
        if (!themes.includes(data.theme)) { send(ws, { type: 'error', message: 'Недопустимая тема' }); return; }
        u.theme = data.theme; saveUsers();
        send(ws, { type: 'theme_set', theme: u.theme });
        break;
      }

      case 'set_bg': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        u.bgImage = data.bgImage || ''; saveUsers();
        send(ws, { type: 'bg_set' });
        break;
      }

      case 'set_name_color': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        u.nameColor = data.color || ''; saveUsers();
        send(ws, { type: 'name_color_set' });
        break;
      }

      // ============ STICKERS ============
      case 'add_sticker': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (!u.premium) { send(ws, { type: 'error', message: 'Только для Premium' }); return; }
        if (!data.sticker) { send(ws, { type: 'error', message: 'Нет данных стикера' }); return; }
        if (!u.stickers) u.stickers = [];
        if (u.stickers.length >= 20) { send(ws, { type: 'error', message: 'Максимум 20 стикеров' }); return; }
        u.stickers.push(data.sticker); saveUsers();
        send(ws, { type: 'sticker_added', stickers: u.stickers });
        break;
      }

      case 'remove_sticker': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (!u.stickers) u.stickers = [];
        if (data.index !== undefined && data.index >= 0 && data.index < u.stickers.length) { u.stickers.splice(data.index, 1); saveUsers(); }
        send(ws, { type: 'sticker_removed', stickers: u.stickers || [] });
        break;
      }

      // ============ BLOCK / REPORT ============
      case 'block_user': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        const target = (data.target || '').trim();
        if (!target || !users[target] || target === session.name) { send(ws, { type: 'error', message: 'Некого блокировать' }); return; }
        if (!u.blocked) u.blocked = [];
        if (!u.blocked.includes(target)) u.blocked.push(target);
        saveUsers(); send(ws, { type: 'blocked', target });
        break;
      }

      case 'unblock_user': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        const target = (data.target || '').trim();
        if (u.blocked) { u.blocked = u.blocked.filter(b => b !== target); saveUsers(); }
        send(ws, { type: 'unblocked', target });
        break;
      }

      case 'report_user': {
        if (!session) return;
        const target = (data.target || '').trim();
        if (!target || !users[target]) { send(ws, { type: 'error', message: 'Пользователь не найден' }); return; }
        console.log(`  🚩 Жалоба от ${session.name} на ${target}: ${data.reason || 'без причины'}`);
        send(ws, { type: 'reported', target });
        break;
      }

      // ============ CALL HISTORY ============
      case 'call_history': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        send(ws, { type: 'call_history_list', history: (u.callHistory || []).slice(-50) });
        break;
      }

      // ============ EXPORT CHAT ============
      case 'export_chat': {
        if (!session) return;
        const conv = getConvForUser(data.convId, session.name);
        if (!conv) { send(ws, { type: 'error', message: 'Нет доступа' }); return; }
        send(ws, { type: 'chat_export', convId: data.convId, messages: messages[data.convId] || [], conversation: conv });
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
        if (isBlocked(session.name, target)) { send(ws, { type: 'error', message: 'Пользователь заблокировал вас' }); return; }
        const convId = [session.name, target].sort().join('::');
        if (!conversations[convId]) { conversations[convId] = { id: convId, type: 'dm', participants: [session.name, target], created: Date.now() }; saveConvs(); }
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
        const inviteCode = genID(8);
        conversations[convId] = { id: convId, type: 'group', name, members, creator: session.name, created: Date.now(), inviteCode, pinned: null };
        saveConvs();
        const sysMsg = { id: 'sys_' + Date.now(), from: 'system', text: `Группа "${name}" создана`, time: new Date().toISOString(), convId, system: true };
        if (!messages[convId]) messages[convId] = []; messages[convId].push(sysMsg); saveMsgs();
        for (const [client, s] of sessions) { if (members.includes(s.name) && client.readyState === 1) send(client, { type: 'group_created', conversation: conversations[convId] }); }
        break;
      }

      case 'add_to_group': {
        if (!session) return;
        const convId = data.convId; const conv = conversations[convId];
        if (!conv || conv.type !== 'group') { send(ws, { type: 'error', message: 'Группа не найдена' }); return; }
        if (!conv.members.includes(session.name)) { send(ws, { type: 'error', message: 'Вы не в группе' }); return; }
        const target = (data.target || '').trim();
        if (!target || !users[target]) { send(ws, { type: 'error', message: 'Пользователь не найден' }); return; }
        if (conv.members.includes(target)) { send(ws, { type: 'error', message: 'Уже в группе' }); return; }
        conv.members.push(target); saveConvs();
        const sysMsg = { id: 'sys_' + Date.now(), from: 'system', text: `${session.name} добавил(а) ${target}`, time: new Date().toISOString(), convId, system: true };
        if (!messages[convId]) messages[convId] = []; messages[convId].push(sysMsg); saveMsgs();
        for (const [client, s] of sessions) { if (conv.members.includes(s.name) && client.readyState === 1) { send(client, { type: 'group_updated', conversation: conv }); send(client, { type: 'new_msg', message: sysMsg }); } }
        break;
      }

      case 'join_group_by_invite': {
        if (!session) return;
        const code = (data.code || '').trim().toLowerCase();
        const conv = Object.values(conversations).find(c => c.type === 'group' && c.inviteCode === code);
        if (!conv) { send(ws, { type: 'error', message: 'Неверная ссылка приглашения' }); return; }
        if (conv.members.includes(session.name)) { send(ws, { type: 'error', message: 'Вы уже в группе' }); return; }
        conv.members.push(session.name); saveConvs();
        const sysMsg = { id: 'sys_' + Date.now(), from: 'system', text: `${session.name} присоединился(ась) по ссылке`, time: new Date().toISOString(), convId: conv.id, system: true };
        if (!messages[conv.id]) messages[conv.id] = []; messages[conv.id].push(sysMsg); saveMsgs();
        for (const [client, s] of sessions) { if (conv.members.includes(s.name) && client.readyState === 1) { send(client, { type: 'group_updated', conversation: conv }); send(client, { type: 'new_msg', message: sysMsg }); } }
        send(ws, { type: 'group_joined', conversation: conv });
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
          const membersInfo = conv.members.map(n => ({ name: n, ...(users[n] ? { color: users[n].color, avatar: users[n].avatar, bio: users[n].bio, online: Array.from(sessions.values()).some(s => s.name === n), premium: !!users[n].premium } : {}) }));
          send(ws, { type: 'conv_info', conversation: conv, members: membersInfo });
        } else { send(ws, { type: 'conv_info', conversation: conv }); }
        break;
      }

      // ============ MESSAGES ============
      case 'get_messages': {
        if (!session) return;
        const convId = data.convId; if (!convId) return;
        if (!getConvForUser(convId, session.name)) return;
        const msgs = (messages[convId] || []).slice(-200);
        send(ws, { type: 'msgs_list', convId, messages: msgs });
        break;
      }

      case 'send_msg': {
        if (!session) return;
        const text = (data.text || '').trim();
        if (!text) return;
        const convId = data.convId;
        if (!convId) return;
        const conv = getConvForUser(convId, session.name);
        if (!conv) return;
        // Check if blocked
        if (conv.type === 'dm') {
          const other = conv.participants.find(p => p !== session.name);
          if (other && isBlocked(session.name, other)) { send(ws, { type: 'error', message: 'Пользователь заблокировал вас' }); return; }
        }
        const msg = { id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), from: session.name, text, time: new Date().toISOString(), convId };
        // Reply
        if (data.replyTo) msg.replyTo = data.replyTo;
        if (!messages[convId]) messages[convId] = [];
        messages[convId].push(msg);
        if (messages[convId].length > 200) messages[convId] = messages[convId].slice(-200);
        saveMsgs();
        sendToConv(conv, { type: 'new_msg', message: msg });
        break;
      }

      case 'edit_msg': {
        if (!session) return;
        const convId = data.convId; const msgId = data.msgId;
        const newText = (data.text || '').trim();
        if (!convId || !msgId || !newText) return;
        const msgs = messages[convId]; if (!msgs) return;
        const msg = msgs.find(m => m.id === msgId);
        if (!msg || msg.from !== session.name) { send(ws, { type: 'error', message: 'Нельзя редактировать' }); return; }
        msg.text = newText; msg.edited = true; saveMsgs();
        const conv = conversations[convId]; if (conv) sendToConv(conv, { type: 'msg_edited', convId, msgId, text: newText });
        break;
      }

      case 'delete_msg_all': {
        if (!session) return;
        const convId = data.convId; const msgId = data.msgId;
        if (!convId || !msgId) return;
        const msgs = messages[convId]; if (!msgs) return;
        const msg = msgs.find(m => m.id === msgId);
        if (!msg || msg.from !== session.name) { send(ws, { type: 'error', message: 'Нельзя удалить' }); return; }
        const idx = msgs.indexOf(msg);
        if (idx >= 0) { msgs.splice(idx, 1); saveMsgs(); }
        const conv = conversations[convId]; if (conv) sendToConv(conv, { type: 'msg_deleted', convId, msgId });
        break;
      }

      // ============ READ RECEIPTS ============
      case 'msg_read': {
        if (!session) return;
        const convId = data.convId; if (!convId) return;
        const conv = getConvForUser(convId, session.name);
        if (!conv) return;
        sendToConv(conv, { type: 'msg_read', name: session.name, convId }, ws);
        break;
      }

      // ============ PIN MESSAGES ============
      case 'pin_msg': {
        if (!session) return;
        const convId = data.convId; const conv = conversations[convId];
        if (!conv || !getConvForUser(convId, session.name)) return;
        if (conv.type === 'group' && conv.creator !== session.name) { send(ws, { type: 'error', message: 'Только создатель может закрепить' }); return; }
        const msgs = messages[convId]; if (!msgs) return;
        const msg = msgs.find(m => m.id === data.msgId);
        if (!msg) return;
        conv.pinned = { id: msg.id, text: msg.text.slice(0, 50), from: msg.from, time: msg.time }; saveConvs();
        sendToConv(conv, { type: 'msg_pinned', convId, pinned: conv.pinned });
        break;
      }

      case 'unpin_msg': {
        if (!session) return;
        const convId = data.convId; const conv = conversations[convId];
        if (!conv || !getConvForUser(convId, session.name)) return;
        if (conv.type === 'group' && conv.creator !== session.name) { send(ws, { type: 'error', message: 'Только создатель может открепить' }); return; }
        if (conv.pinned) { conv.pinned = null; saveConvs(); }
        sendToConv(conv, { type: 'msg_unpinned', convId });
        break;
      }

      // ============ FAVORITE ============
      case 'favorite_msg': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (!u.favorites) u.favorites = [];
        if (!u.favorites.includes(data.msgId)) u.favorites.push(data.msgId); saveUsers();
        send(ws, { type: 'favorited', msgId: data.msgId });
        break;
      }

      case 'unfavorite_msg': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        if (u.favorites) { u.favorites = u.favorites.filter(f => f !== data.msgId); saveUsers(); }
        send(ws, { type: 'unfavorited', msgId: data.msgId });
        break;
      }

      case 'get_favorites': {
        if (!session) return; const u = users[session.name]; if (!u) return;
        const favs = (u.favorites || []).map(fid => {
          for (const cid in messages) { const m = messages[cid].find(mm => mm.id === fid); if (m) return m; }
          return null;
        }).filter(Boolean);
        send(ws, { type: 'favorites_list', messages: favs });
        break;
      }

      // ============ CHAT THEMES (per-conversation) ============
      case 'set_conv_bg': {
        if (!session) return;
        const conv = getConvForUser(data.convId, session.name);
        if (!conv) return;
        if (!conv.bgImages) conv.bgImages = {};
        conv.bgImages[session.name] = data.bgImage || ''; saveConvs();
        send(ws, { type: 'conv_bg_set', convId: data.convId });
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

      // ============ POLLS ============
      case 'create_poll': {
        if (!session) return;
        const convId = data.convId; const conv = getConvForUser(convId, session.name);
        if (!conv) return;
        const question = (data.question || '').trim().slice(0, 100);
        const options = (data.options || []).slice(0, 10).map(o => (o || '').trim()).filter(Boolean);
        if (!question || options.length < 2) { send(ws, { type: 'error', message: 'Введите вопрос и минимум 2 варианта' }); return; }
        const pollId = 'poll_' + Date.now();
        const poll = { id: pollId, question, options: options.map(o => ({ text: o, votes: [] })), voters: [], creator: session.name };
        const msg = { id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), from: session.name, text: `[poll]${JSON.stringify(poll)}`, time: new Date().toISOString(), convId, poll: true };
        if (!messages[convId]) messages[convId] = [];
        messages[convId].push(msg);
        if (messages[convId].length > 200) messages[convId] = messages[convId].slice(-200);
        saveMsgs();
        sendToConv(conv, { type: 'new_msg', message: msg });
        break;
      }

      case 'vote_poll': {
        if (!session) return;
        const convId = data.convId; const msgId = data.msgId; const optIdx = data.option;
        if (!convId || !msgId || optIdx === undefined) return;
        const msgs = messages[convId]; if (!msgs) return;
        const msg = msgs.find(m => m.id === msgId);
        if (!msg || !msg.poll) return;
        const poll = JSON.parse(msg.text.replace('[poll]', ''));
        if (poll.voters.includes(session.name)) { send(ws, { type: 'error', message: 'Вы уже голосовали' }); return; }
        if (optIdx < 0 || optIdx >= poll.options.length) return;
        poll.options[optIdx].votes.push(session.name);
        poll.voters.push(session.name);
        msg.text = '[poll]' + JSON.stringify(poll); saveMsgs();
        const conv = conversations[convId]; if (conv) sendToConv(conv, { type: 'poll_updated', convId, msgId, poll });
        break;
      }

      // ============ CALLS (WebRTC) ============
      case 'call_user': {
        if (!session) return; const target = (data.target || '').trim();
        if (!target || !users[target]) return;
        for (const [client, s] of sessions) {
          if (s.name === target && client.readyState === 1) { send(client, { type: 'incoming_call', from: session.name, video: !!data.video }); send(ws, { type: 'call_ringing', target }); return; }
        }
        send(ws, { type: 'error', message: 'Пользователь не в сети' });
        break;
      }

      case 'call_accept': {
        if (!session) return; const target = (data.target || '').trim();
        for (const [client, s] of sessions) { if (s.name === target && client.readyState === 1) { send(client, { type: 'call_accepted', from: session.name }); break; } }
        break;
      }

      case 'call_reject': {
        if (!session) return; const target = (data.target || '').trim();
        for (const [client, s] of sessions) { if (s.name === target && client.readyState === 1) { send(client, { type: 'call_rejected', from: session.name }); break; } }
        break;
      }

      case 'call_end': {
        if (!session) return; const target = (data.target || '').trim();
        const u = users[session.name];
        if (u) { if (!u.callHistory) u.callHistory = []; u.callHistory.push({ with: target, type: data.video ? 'video' : 'audio', duration: data.duration || 0, time: new Date().toISOString(), direction: 'outgoing' }); if (u.callHistory.length > 50) u.callHistory = u.callHistory.slice(-50); saveUsers(); }
        const tu = users[target];
        if (tu) { if (!tu.callHistory) tu.callHistory = []; tu.callHistory.push({ with: session.name, type: data.video ? 'video' : 'audio', duration: data.duration || 0, time: new Date().toISOString(), direction: 'incoming' }); if (tu.callHistory.length > 50) tu.callHistory = tu.callHistory.slice(-50); saveUsers(); }
        for (const [client, s] of sessions) { if (s.name === target && client.readyState === 1) { send(client, { type: 'call_ended', from: session.name }); break; } }
        break;
      }

      case 'offer': case 'answer': case 'ice_candidate': {
        if (!session) return; const target = data.target; if (!target) return;
        for (const [client, s] of sessions) { if (s.name === target && client.readyState === 1) { send(client, { type: data.type, from: session.name, data: data.data }); break; } }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (session) {
      if (users[session.name]) users[session.name].lastSeen = Date.now();
      saveUsers(); sessions.delete(ws);
      broadcast({ type: 'user_offline', name: session.name, users: buildUserList(), online: sessions.size });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const avail = (premiumKeys.keys || []).filter(k => !k.used);
  console.log(`\n  ✦ Poins Messenger запущен на порту ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  🔑 Свободных ключей: ${avail.length}`);
  if (avail.length) { console.log(`  ─── Первые 3 ключа ───`); avail.slice(0, 3).forEach(k => console.log(`  ${k.code}`)); console.log(`  ─────────────────────`); console.log(`  📋 Все ключи: http://localhost:${PORT}/admin/keys`); }
});
