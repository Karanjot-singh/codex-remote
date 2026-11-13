import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, openSync, readSync, closeSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { host, port, stateDir, readRegistry, writeRegistry, publicEvent, activityEvent, codexBin } from './core.mjs';

const sessions = new Map();
let wake = null;
let stopping = false;
let cachedTailnetOwner = { login: null, until: 0 };

function tailnetOwnerLogin() {
  const configured = process.env.CODEX_REMOTE_TAILSCALE_LOGIN?.trim().toLowerCase();
  if (configured) return configured;
  if (Date.now() < cachedTailnetOwner.until) return cachedTailnetOwner.login;
  let login = null;
  for (const binary of ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) {
    try {
      const status = JSON.parse(execFileSync(binary, ['status', '--json'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const userId = String(status.Self?.UserID ?? '');
      login = status.User?.[userId]?.LoginName?.trim().toLowerCase() || null;
      if (login) break;
    } catch {}
  }
  cachedTailnetOwner = { login, until: Date.now() + 5 * 60 * 1000 };
  return login;
}

function isTailnetOwner(req) {
  const requester = req.headers['tailscale-user-login'];
  const owner = tailnetOwnerLogin();
  return Boolean(owner && typeof requester === 'string' && requester.trim().toLowerCase() === owner);
}

function closeClients(session) {
  for (const client of session.clients) client.end();
  session.clients.clear();
}

function refreshSessions() {
  const desired = readRegistry().sessions;
  for (const [id, session] of sessions) {
    if (!desired[id] || desired[id].token !== session.state.token) {
      closeClients(session);
      sessions.delete(id);
    }
  }
  for (const [id, state] of Object.entries(desired)) {
    if (!sessions.has(id)) {
      sessions.set(id, { state, offset: 0, partial: '', sequence: 0, events: [], clients: new Set(), latestStatus: 'idle', queueBusy: false });
    }
  }
}

function ensureWake() {
  if (stopping) return;
  if (sessions.size && !wake) {
    wake = spawn('/usr/bin/caffeinate', ['-i'], { stdio: 'ignore' });
    wake.once('error', () => { wake = null; });
    wake.once('exit', () => { wake = null; });
  } else if (!sessions.size && wake) {
    wake.kill('SIGTERM');
    wake = null;
  }
}

function send(session, client, event, replay = false) {
  if (client.writableEnded || client.destroyed) { session.clients.delete(client); return false; }
  try {
    if (!client.write('id: ' + event.seq + '\ndata: ' + JSON.stringify(event) + '\n\n') && !replay) {
      session.clients.delete(client);
      client.end();
      return false;
    }
    return true;
  } catch { session.clients.delete(client); return false; }
}

function push(session, event) {
  session.events.push(event);
  if (session.events.length > 200) session.events.shift();
  if (event.kind === 'started') session.latestStatus = 'running';
  if (event.kind === 'completed') session.latestStatus = 'completed';
  for (const client of session.clients) send(session, client, event);
}

function scanSession(session) {
  try {
    const size = statSync(session.state.rolloutPath).size;
    if (size < session.offset) { session.offset = 0; session.partial = ''; session.sequence = 0; session.events = []; }
    if (size === session.offset) return;
    const fd = openSync(session.state.rolloutPath, 'r');
    try {
      const max = Math.min(size - session.offset, 1024 * 1024);
      const buf = Buffer.allocUnsafe(max);
      const count = readSync(fd, buf, 0, max, session.offset);
      session.offset += count;
      const lines = (session.partial + buf.subarray(0, count).toString('utf8')).split('\n');
      session.partial = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        try {
          const event = publicEvent(JSON.parse(line), ++session.sequence);
          if (event) push(session, event);
        } catch {}
      }
    } finally { closeSync(fd); }
  } catch { session.latestStatus = 'log_error'; }
}

function scan() {
  refreshSessions();
  ensureWake();
  for (const session of sessions.values()) scanSession(session);
}

function recentActivity(session, limit = 60) {
  const size = statSync(session.state.rolloutPath).size;
  if (!size) return [];
  const length = Math.min(size, 2 * 1024 * 1024);
  const start = size - length;
  const fd = openSync(session.state.rolloutPath, 'r');
  let count;
  const buffer = Buffer.allocUnsafe(length);
  try { count = readSync(fd, buffer, 0, length, start); }
  finally { closeSync(fd); }
  const lines = buffer.subarray(0, count).toString('utf8').split('\n');
  if (start > 0) lines.shift();
  if (!lines.at(-1)) lines.pop();
  const found = [];
  for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
    try {
      const event = activityEvent(JSON.parse(lines[i]));
      if (event) found.push(event);
    } catch {}
  }
  return found.reverse();
}

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.includes('=')).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index), part.slice(index + 1)];
  }));
}

function authorized(req, id) {
  const session = sessions.get(id);
  if (!session) return null;
  const jar = cookies(req);
  return jar['codex_remote_' + id] === session.state.token || jar.codex_remote === session.state.token ? session : null;
}

function authorizedSessions(req) {
  return [...sessions.entries()].filter(([id]) => authorized(req, id));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || !req.headers.host) return false;
  const expected = new URL('http://' + req.headers.host).origin;
  return origin === expected || origin === 'https://' + req.headers.host;
}

async function body(req, maxBytes = 8192) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Prompt too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function saveImage(image) {
  if (!image || typeof image !== 'object' || typeof image.data !== 'string' ||
      image.data.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
    throw new Error('Invalid image');
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > 3 * 1024 * 1024 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('Image must be a JPEG under 3 MiB');
  }
  const dir = join(stateDir, 'uploads');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f-]{36}\.jpg$/.test(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (Date.now() - info.mtimeMs > 7 * 24 * 60 * 60 * 1000) unlinkSync(path);
    else total += info.size;
  }
  if (total + bytes.length > 50 * 1024 * 1024) throw new Error('Upload storage is full');
  const path = join(dir, randomUUID() + '.jpg');
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  return path;
}

function disableSession(id) {
  const registry = readRegistry();
  delete registry.sessions[id];
  writeRegistry(registry);
  const session = sessions.get(id);
  if (session) closeClients(session);
  sessions.delete(id);
  ensureWake();
}

function viewerCount() {
  let count = 0;
  for (const session of sessions.values()) count += session.clients.size;
  return count;
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/health') return json(res, 200, { ready: Boolean(sessions.size && wake), enabled: Boolean(sessions.size), sessions: sessions.size, wake: Boolean(wake) });

  if (url.pathname === '/remote') {
    if (!isTailnetOwner(req)) return json(res, 403, { error: 'Tailscale identity is not allowed' });
    const enabled = [...sessions.entries()];
    if (!enabled.length) return json(res, 403, { error: 'No remote chats are enabled' });
    const [id] = enabled.at(-1);
    res.writeHead(302, {
      Location: '/chat/' + id,
      'Set-Cookie': enabled.map(([threadId, session]) => 'codex_remote_' + threadId + '=' + session.state.token + '; HttpOnly; SameSite=Strict; Path=/'),
      'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'
    });
    return res.end();
  }

  const stableChat = url.pathname.match(/^\/remote\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (stableChat) {
    const id = stableChat[1];
    const session = sessions.get(id);
    if (!session || !isTailnetOwner(req)) {
      return json(res, 403, { error: 'Remote chat is disabled or Tailscale identity is not allowed' });
    }
    res.writeHead(302, { Location: '/chat/' + id, 'Set-Cookie': 'codex_remote_' + id + '=' + session.state.token + '; HttpOnly; SameSite=Strict; Path=/', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname.startsWith('/s/')) {
    const token = url.pathname.slice(3);
    const match = [...sessions.entries()].find(([, session]) => session.state.token === token);
    if (!match) return json(res, 403, { error: 'Remote link is invalid or expired' });
    const [id] = match;
    res.writeHead(302, { Location: '/chat/' + id, 'Set-Cookie': 'codex_remote_' + id + '=' + token + '; HttpOnly; SameSite=Strict; Path=/', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname === '/') {
    const match = authorizedSessions(req)[0];
    if (!match) return json(res, 403, { error: 'Open an enabled chat link first' });
    res.writeHead(302, { Location: '/chat/' + match[0], 'Cache-Control': 'no-store' });
    return res.end();
  }

  const chat = url.pathname.match(/^\/chat\/([0-9a-f-]{36})$/i);
  if (chat) {
    if (!authorized(req, chat[1])) return json(res, 403, { error: 'Remote chat is disabled or link is invalid' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'self'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    return res.end(readFileSync(new URL('./web.html', import.meta.url)));
  }

  if (url.pathname === '/app.js') {
    if (!authorizedSessions(req).length) return json(res, 403, { error: 'Remote chat is disabled' });
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(readFileSync(new URL('./app.js', import.meta.url)));
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return json(res, 200, authorizedSessions(req).map(([id, session]) => ({ threadId: id, status: session.latestStatus, wake: Boolean(wake) })));
  }

  const route = url.pathname.match(/^\/api\/chats\/([0-9a-f-]{36})\/(status|events|stream|message|disable|activity)$/i);
  const legacy = url.pathname.match(/^\/api\/(status|events|stream|message|disable)$/);
  const id = route?.[1] || (legacy ? authorizedSessions(req)[0]?.[0] : null);
  const action = route?.[2] || legacy?.[1];
  if (!action) return json(res, 404, { error: 'Not found' });
  if (!id) return json(res, 403, { error: 'Remote chat is disabled or link is invalid' });
  const session = authorized(req, id);
  if (!session) return json(res, 403, { error: 'Remote chat is disabled or link is invalid' });

  if (req.method === 'GET' && action === 'status') {
    return json(res, 200, { threadId: id, status: legacy ? 'Refresh page for new layout' : session.latestStatus, lastSequence: session.sequence, wake: Boolean(wake) });
  }
  if (req.method === 'GET' && action === 'events') {
    const after = Math.max(0, Number(url.searchParams.get('after') || 0) || 0);
    return json(res, 200, session.events.filter(event => event.seq > after));
  }
  if (req.method === 'GET' && action === 'activity') {
    try { return json(res, 200, recentActivity(session)); }
    catch { return json(res, 500, { error: 'Activity is unavailable' }); }
  }
  if (req.method === 'GET' && action === 'stream') {
    if (viewerCount() >= 8) return json(res, 429, { error: 'Too many live viewers' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    session.clients.add(res);
    res.on('error', () => session.clients.delete(res));
    const after = Math.max(0, Number(url.searchParams.get('after') || 0) || 0);
    for (const event of session.events.filter(event => event.seq > after)) {
      if (!send(session, res, event, true)) break;
    }
    res.once('close', () => session.clients.delete(res));
    return;
  }

  if (req.method === 'POST' && action === 'disable') {
    if (!sameOrigin(req) || !String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 403, { error: 'Invalid origin or content type' });
    try { disableSession(id); } catch { return json(res, 500, { error: 'Could not end remote access' }); }
    return json(res, 200, { disabled: true, wake: Boolean(wake), remainingSessions: sessions.size }, { 'Set-Cookie': 'codex_remote_' + id + '=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/' });
  }

  if (req.method === 'POST' && action === 'message') {
    if (!sameOrigin(req) || !String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 403, { error: 'Invalid origin or content type' });
    if (session.queueBusy) return json(res, 409, { error: 'Submission already in progress' });
    let data;
    try { data = await body(req, 4 * 1024 * 1024 + 16384); } catch { return json(res, 400, { error: 'Invalid JSON or prompt too large' }); }
    const prompt = data?.prompt;
    if (typeof prompt !== 'string' || (!prompt.trim() && !data?.image) || prompt.length > 8000) return json(res, 400, { error: 'Prompt must be 1-8000 characters or include an image' });
    if (sessions.get(id) !== session) return json(res, 403, { error: 'Remote chat is disabled' });
    session.queueBusy = true;
    let imagePath;
    try { if (data.image) imagePath = saveImage(data.image); }
    catch (error) { session.queueBusy = false; return json(res, 400, { error: error.message }); }
    const message = prompt.trim() + (imagePath ? '\n\nImage attached from phone: ' + imagePath + '\nPlease inspect this local image as part of my request.' : '');
    const child = spawn(codexBin, ['queue', '--thread', id, '--message', message], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEX_THREAD_ID: '' } });
    child.stdout.resume();
    child.stderr.resume();
    let settled = false;
    const discardImage = () => { if (imagePath) { try { unlinkSync(imagePath); } catch {} } };
    child.once('error', error => {
      if (settled) return;
      settled = true;
      session.queueBusy = false;
      discardImage();
      if (!res.writableEnded) json(res, 502, { error: 'Codex queue failed: ' + error.message });
    });
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      session.queueBusy = false;
      if (code !== 0) discardImage();
      if (res.writableEnded) return;
      if (code === 0) json(res, 202, { status: 'queued', imageAccepted: Boolean(imagePath), note: 'Message queued for this Codex chat' });
      else json(res, 502, { error: 'Codex queue failed', exitCode: code });
    });
    return;
  }
  json(res, 404, { error: 'Not found' });
}

refreshSessions();
if (process.env.CODEX_REMOTE_NO_LISTEN !== '1') {
  const server = http.createServer(handleRequest);
  server.on('error', error => {
    console.error('Unable to start local bridge: ' + error.message);
    if (wake) wake.kill('SIGTERM');
    process.exit(1);
  });
  server.listen(port, host, () => console.log('Codex remote bridge listening on http://' + host + ':' + port));
  scan();
  const scanTimer = setInterval(scan, 1000);
  const pingTimer = setInterval(() => {
    for (const session of sessions.values()) {
      for (const client of session.clients) {
        if (client.writableEnded || client.destroyed) { session.clients.delete(client); continue; }
        try {
          if (!client.write(': ping\n\n')) { session.clients.delete(client); client.end(); }
        } catch { session.clients.delete(client); }
      }
    }
  }, 15000);
  scanTimer.unref();
  pingTimer.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    stopping = true;
    clearInterval(scanTimer);
    clearInterval(pingTimer);
    for (const session of sessions.values()) closeClients(session);
    if (wake) wake.kill('SIGTERM');
    server.close(() => process.exit(0));
  });
}
