import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('separate chat links, menu visibility, and last-session wake release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-remote-multi-'));
  const ids = ['12345678-1234-4123-8123-123456789abc', '12345678-1234-4123-8123-123456789abd'];
  const tokens = ['test-session-token-aaaa', 'test-session-token-bbbb'];
  const sessions = {};
  ids.forEach((id, index) => {
    const rolloutPath = join(dir, `rollout-${index}.jsonl`);
    writeFileSync(rolloutPath, '');
    sessions[id] = { enabled: true, threadId: id, rolloutPath, token: tokens[index], expiresAt: new Date(Date.now() + 60000).toISOString() };
  });
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  const queueLog = join(dir, 'queue.json');
  const mock = join(dir, 'mock-codex');
  writeFileSync(mock, '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.MOCK_QUEUE_LOG,JSON.stringify(process.argv.slice(2)));\n');
  chmodSync(mock, 0o700);
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  listener.close();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, CODEX_REMOTE_STATE_DIR: dir, CODEX_REMOTE_PORT: String(port), CODEX_REMOTE_CODEX_BIN: mock, CODEX_REMOTE_TAILSCALE_LOGIN: 'owner@example.com', MOCK_QUEUE_LOG: queueLog },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { ready = (await fetch(origin + '/health').then(r => r.json())).ready; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const home = await fetch(origin + '/remote', { headers: { 'Tailscale-User-Login': 'owner@example.com' }, redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/chat/' + ids[1]);
    assert.equal(home.headers.getSetCookie().length, 2);
    const first = await fetch(origin + '/s/' + tokens[0], { redirect: 'manual' });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), '/chat/' + ids[0]);
    const cookieA = first.headers.get('set-cookie').split(';')[0];
    const second = await fetch(origin + '/s/' + tokens[1], { redirect: 'manual' });
    const cookieB = second.headers.get('set-cookie').split(';')[0];
    const menuA = await fetch(origin + '/api/sessions', { headers: { Cookie: cookieA } }).then(r => r.json());
    assert.deepEqual(menuA.map(x => x.threadId), [ids[0]]);
    assert.equal((await fetch(origin + '/api/chats/' + ids[1] + '/status', { headers: { Cookie: cookieA } })).status, 403);
    const both = { Cookie: cookieA + '; ' + cookieB };
    const menuBoth = await fetch(origin + '/api/sessions', { headers: both }).then(r => r.json());
    assert.deepEqual(menuBoth.map(x => x.threadId), ids);
    const send = await fetch(origin + '/api/chats/' + ids[1] + '/message', {
      method: 'POST', headers: { ...both, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Second chat only' })
    });
    assert.equal(send.status, 202);
    assert.deepEqual(JSON.parse(readFileSync(queueLog, 'utf8')), ['queue', '--thread', ids[1], '--message', 'Second chat only']);
    const stopA = await fetch(origin + '/api/chats/' + ids[0] + '/disable', {
      method: 'POST', headers: { ...both, Origin: origin, 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.json());
    assert.equal(stopA.remainingSessions, 1);
    assert.equal(stopA.wake, true);
    assert.equal((await fetch(origin + '/api/chats/' + ids[1] + '/status', { headers: both })).status, 200);
    const stopB = await fetch(origin + '/api/chats/' + ids[1] + '/disable', {
      method: 'POST', headers: { ...both, Origin: origin, 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.json());
    assert.equal(stopB.remainingSessions, 0);
    assert.equal(stopB.wake, false);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
    rmSync(dir, { recursive: true, force: true });
  }
});
