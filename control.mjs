import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readRegistry, writeRegistry, rolloutPathForThread, validThreadId, host, port } from './core.mjs';

function privatePhoneOrigin() {
  for (const binary of ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) {
    try {
      const config = JSON.parse(execFileSync(binary, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
      for (const [name, service] of Object.entries(config.Web || {})) {
        if (service?.Handlers?.['/']?.Proxy === `http://${host}:${port}` && !config.AllowFunnel?.[name]) {
          return `https://${name}`;
        }
      }
    } catch {}
  }
  return null;
}

function printLinks(threadId, token) {
  console.log('Local URL: http://' + host + ':' + port + '/s/' + token);
  const origin = privatePhoneOrigin();
  if (origin) {
    console.log('Phone URL: ' + origin + '/remote');
    console.log('Chat URL: ' + origin + '/remote/' + threadId);
    console.log('Fallback URL: ' + origin + '/s/' + token);
  }
  else console.log('Phone URL: configure a private Tailscale Serve mapping for localhost:' + port);
}

const action = process.argv[2];
if (!['enable', 'disable', 'status', 'link'].includes(action)) {
  console.error('Usage: node control.mjs enable|status|link [thread-id]|disable [thread-id]');
  process.exit(2);
}
const registry = readRegistry();
const sessions = registry.sessions;
if (action === 'status') {
  const ids = Object.keys(sessions);
  console.log(ids.length ? 'Enabled chats:\n' + ids.join('\n') : 'Remote access disabled');
  process.exit(0);
}
if (action === 'link') {
  const id = process.argv[3] || process.env.CODEX_THREAD_ID || (Object.keys(sessions).length === 1 ? Object.keys(sessions)[0] : null);
  const state = sessions[id];
  if (!state) {
    console.error('Choose an enabled thread ID. Run status to list them.');
    process.exit(1);
  }
  printLinks(id, state.token);
  process.exit(0);
}
if (action === 'disable') {
  const id = process.argv[3];
  if (id && !validThreadId(id)) { console.error('Invalid thread ID'); process.exit(2); }
  if (id) delete sessions[id];
  else for (const key of Object.keys(sessions)) delete sessions[key];
  writeRegistry({ version: 1, sessions });
  console.log(id ? 'Remote access disabled for chat ' + id : 'All remote sessions disabled; Mac may sleep normally');
  process.exit(0);
}
const threadId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if (!validThreadId(threadId)) {
  console.error('Enable must run from inside a Codex chat with CODEX_THREAD_ID available.');
  process.exit(2);
}
if (sessions[threadId]) {
  console.log('Remote access is already enabled for this chat.');
  printLinks(threadId, sessions[threadId].token);
  process.exit(0);
}
if (!sessions[threadId] && Object.keys(sessions).length >= 8) {
  console.error('Eight remote chats are already enabled. Disable one before adding another.');
  process.exit(1);
}
const rolloutPath = rolloutPathForThread(threadId);
const token = randomBytes(24).toString('base64url');
sessions[threadId] = { enabled: true, threadId, rolloutPath, token, enabledAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
writeRegistry({ version: 1, sessions });
console.log('Enabled the current Codex chat.');
printLinks(threadId, token);
