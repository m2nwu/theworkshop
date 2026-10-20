// 공방 THE WORKSHOP — Cloudflare 서버
// 게임 페이지(public/index.html)는 Cloudflare가 그대로 보내 주고, /api/* 요청만 이 코드가 처리합니다.
// 계정·로그인 세션·저장 기록은 Durable Object(Store) 안의 SQLite에 보관합니다.
// 친선 배틀의 실시간 방은 Durable Object(Room)가 웹소켓으로 이어 줍니다.
import { DurableObject } from 'cloudflare:workers';

// 골드 코드: 서버에만 있어서 페이지 소스를 봐도 보이지 않습니다. 한 계정에 한 번씩만 쓸 수 있어요.
const GOLD_CODES = { SMTM: 99999, WELCOME: 10, BOXKIT: 100 };

const ID_RE = /^[a-zA-Z0-9_]{3,16}$/;
const SESSION_DAYS = 60;
const MAX_SAVE = 256 * 1024;
const PBKDF2_ITER = 100000; // Workers의 PBKDF2 최대값

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function hashPw(pw, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return hex(bits);
}
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(ea, eb);
  let d = 0; for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i]; return d === 0;
}

// 저장 데이터 정리: 모양이 이상한 값은 버립니다
function cleanSave(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const num = (v, max = 1e9) => Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.floor(+v))) : 0;
  const g = d.gold && typeof d.gold === 'object' ? d.gold : {};
  const obj = o => {
    const out = {}; if (!o || typeof o !== 'object') return out;
    for (const k of Object.keys(o).slice(0, 6000)) if (/^[A-Za-z0-9_-]{1,24}$/.test(k)) out[k] = num(o[k], 1e7);
    return out;
  };
  return {
    v: 1,
    gold: { total: num(g.total), wins: num(g.wins), best: num(g.best), streak: num(g.streak) },
    owned: obj(d.owned), seen: obj(d.seen),
    equip: typeof d.equip === 'string' && d.equip.length < 40 ? d.equip : null,
    codes: Array.isArray(d.codes) ? [...new Set(d.codes.filter(c => typeof c === 'string' && c.length < 24))].slice(0, 100) : []
  };
}

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, exp INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS saves (uid TEXT PRIMARY KEY, data TEXT NOT NULL, rev TEXT NOT NULL, at INTEGER NOT NULL)');
  }
  row(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  newSession(uid) {
    const token = randHex(32), exp = Date.now() + SESSION_DAYS * 864e5;
    this.sql.exec('INSERT INTO sessions (token, uid, exp) VALUES (?, ?, ?)', token, uid, exp);
    this.sql.exec('DELETE FROM sessions WHERE exp < ?', Date.now());
    return token;
  }
  auth(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const s = this.row('SELECT uid, exp FROM sessions WHERE token = ?', token);
    if (!s || s.exp < Date.now()) return null;
    return this.row('SELECT id, name FROM users WHERE id = ?', s.uid);
  }
  saveOf(uid) {
    const r = this.row('SELECT data, rev, at FROM saves WHERE uid = ?', uid);
    return r ? { save: JSON.parse(r.data), rev: r.rev, at: r.at } : { save: null, rev: null, at: 0 };
  }
  writeSave(uid, data) {
    const rev = randHex(6), at = Date.now();
    this.sql.exec('INSERT INTO saves (uid, data, rev, at) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET data = excluded.data, rev = excluded.rev, at = excluded.at', uid, JSON.stringify(data), rev, at);
    return { rev, at };
  }

  async signup(name, pw) {
    name = String(name || '').trim(); pw = String(pw || '');
    if (!ID_RE.test(name)) return { error: 'badId' };
    if (pw.length < 6 || pw.length > 64) return { error: 'badPw' };
    const id = name.toLowerCase();
    if (this.row('SELECT id FROM users WHERE id = ?', id)) return { error: 'taken' };
    const salt = randHex(16), hash = await hashPw(pw, salt);
    this.sql.exec('INSERT INTO users (id, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)', id, name, salt, hash, Date.now());
    return { token: this.newSession(id), user: { id, name } };
  }
  async login(name, pw) {
    const id = String(name || '').trim().toLowerCase(); pw = String(pw || '');
    const u = this.row('SELECT id, name, salt, hash, fails, locked FROM users WHERE id = ?', id);
    if (!u) { await hashPw(pw || 'x', '00'.repeat(16)); return { error: 'wrong' }; }
    if (u.locked > Date.now()) return { error: 'locked', wait: Math.ceil((u.locked - Date.now()) / 1000) };
    const ok = sameHex(await hashPw(pw, u.salt), u.hash);
    if (!ok) {
      const fails = u.fails + 1, locked = fails >= 5 ? Date.now() + 60000 : 0;
      this.sql.exec('UPDATE users SET fails = ?, locked = ? WHERE id = ?', locked ? 0 : fails, locked, id);
      return { error: 'wrong' };
    }
    this.sql.exec('UPDATE users SET fails = 0, locked = 0 WHERE id = ?', id);
    return { token: this.newSession(id), user: { id: u.id, name: u.name } };
  }
  whoami(token) { return this.auth(token); }
  logout(token) { this.sql.exec('DELETE FROM sessions WHERE token = ?', String(token || '')); return { ok: true }; }

  load(token) {
    const u = this.auth(token); if (!u) return { error: 'auth' };
    return { user: u, ...this.saveOf(u.id) };
  }
  store(token, data) {
    const u = this.auth(token); if (!u) return { error: 'auth' };
    const clean = cleanSave(data); if (!clean) return { error: 'badSave' };
    return { ok: true, ...this.writeSave(u.id, clean) };
  }
  redeem(token, raw) {
    const u = this.auth(token); if (!u) return { error: 'auth' };
    const code = String(raw || '').trim().toUpperCase();
    if (!(code in GOLD_CODES)) return { error: 'badCode' };
    const cur = this.saveOf(u.id).save || cleanSave({});
    if (cur.codes.includes(code)) return { error: 'used' };
    cur.codes.push(code); cur.gold.total = Math.min(1e9, cur.gold.total + GOLD_CODES[code]);
    return { ok: true, n: GOLD_CODES[code], save: cur, ...this.writeSave(u.id, cur) };
  }
}

// ───── 친선 배틀: 실시간 방 ─────
// 접속한 사람 모두가 로비('')에 들어오고, 방('t-xxxxxx')에 들어가면 그 방 사람끼리만 메시지를 주고받습니다.
// 게임 진행은 방장 화면이 맡고, 서버는 메시지를 전달하기만 합니다.
const MAX_MSG = 128 * 1024, MAX_ROOMS = 4, MAX_PRESENCE = 400;
export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const uid = request.headers.get('x-uid'), name = request.headers.get('x-name') || uid;
    const { 0: client, 1: server } = new WebSocketPair();
    const peer = randHex(8);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer, uid, name, rooms: { '': null } });
    server.send(JSON.stringify({ t: 'hello', peer }));
    this.notify('');
    return new Response(null, { status: 101, webSocket: client });
  }
  info(ws) { try { return ws.deserializeAttachment(); } catch (e) { return null; } }
  members(room) { return this.ctx.getWebSockets().filter(w => { const a = this.info(w); return a && a.rooms && room in a.rooms; }); }
  notify(room, left = []) {
    const list = this.members(room);
    const peers = list.map(w => { const a = this.info(w); return { peer: a.peer, by: a.uid, name: a.name, presence: a.rooms[room] ?? null, kind: 'viewer' }; });
    const msg = JSON.stringify({ t: 'peers', room, peers, left });
    for (const w of list) try { w.send(msg); } catch (e) {}
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const a = this.info(ws); if (!a || !m || typeof m !== 'object') return;
    const room = typeof m.room === 'string' ? m.room.slice(0, 40) : '';
    if (room && !/^[a-z0-9-]{1,40}$/.test(room)) return;
    switch (m.t) {
      case 'join':
        if (!(room in a.rooms)) { if (Object.keys(a.rooms).length > MAX_ROOMS) return; a.rooms[room] = null; ws.serializeAttachment(a); }
        this.notify(room); break;
      case 'leave':
        if (room && room in a.rooms) { delete a.rooms[room]; ws.serializeAttachment(a); this.notify(room, [{ peer: a.peer }]); }
        break;
      case 'presence': {
        if (!(room in a.rooms)) return;
        const d = m.data ?? null; if (JSON.stringify(d).length > MAX_PRESENCE) return;
        a.rooms[room] = d; ws.serializeAttachment(a); this.notify(room); break;
      }
      case 'emit': {
        if (!(room in a.rooms)) return;
        const out = JSON.stringify({ t: 'msg', room, topic: String(m.topic || '').slice(0, 16), peer: a.peer, data: m.data ?? null });
        for (const w of this.members(room)) if (w !== ws) try { w.send(out); } catch (e) {}
        break;
      }
      case 'ping': try { ws.send('{"t":"pong"}'); } catch (e) {} break;
    }
  }
  gone(ws) {
    const a = this.info(ws); if (!a) return;
    ws.serializeAttachment(null);
    for (const room in a.rooms) this.notify(room, [{ peer: a.peer }]);
  }
  async webSocketClose(ws, code) { this.gone(ws); try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) {} }
  async webSocketError(ws) { this.gone(ws); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const store = env.STORE.get(env.STORE.idFromName('main'));
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let body = {};
    if (request.method === 'POST' || request.method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_SAVE) return json({ error: 'tooBig' }, 413);
      try { body = text ? JSON.parse(text) : {}; } catch (e) { return json({ error: 'badJson' }, 400); }
    }
    if (url.pathname === '/api/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'expectedWebsocket' }, 426);
      const u = await store.whoami(url.searchParams.get('token') || '');
      if (!u) return new Response('auth', { status: 401 });
      const h = new Headers(request.headers); h.set('x-uid', u.id); h.set('x-name', u.name);
      const room = env.ROOM.get(env.ROOM.idFromName('friendly'));
      return room.fetch(new Request(request, { headers: h }));
    }
    const route = request.method + ' ' + url.pathname;
    let r;
    try {
      switch (route) {
        case 'POST /api/signup': r = await store.signup(body.name, body.password); break;
        case 'POST /api/login': r = await store.login(body.name, body.password); break;
        case 'POST /api/logout': r = await store.logout(token); break;
        case 'GET /api/save': r = await store.load(token); break;
        case 'PUT /api/save': r = await store.store(token, body.save); break;
        case 'POST /api/code': r = await store.redeem(token, body.code); break;
        case 'GET /api/health': r = { ok: true }; break;
        default: return json({ error: 'notFound' }, 404);
      }
    } catch (e) {
      return json({ error: 'server' }, 500);
    }
    // 로그인 필요만 401, 나머지(틀린 비밀번호, 이미 쓴 코드 등)는 200 + error 로 돌려줍니다
    const status = r.error === 'auth' ? 401 : 200;
    return json(r, status);
  }
};
