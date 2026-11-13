import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('stream stays attached after the request closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-remote-stream-'));
  const rollout = join(dir, 'rollout.jsonl');
  const token = 'stream-test-token';
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  listener.close();
  const historical = Array.from({ length: 60 }, (_, i) => JSON.stringify({
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'text', text: `History ${i} ` + 'x'.repeat(7000) }] } }
  })).join('\n') + '\n';
  writeFileSync(rollout, historical + JSON.stringify({
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'printf lazy'], aggregated_output: 'lazy', status: 'completed' } }
  }) + '\n');
  const statePath = join(dir, 'enabled.json');
  const state = {
    enabled: true,
    threadId: '12345678-1234-4123-8123-123456789abc',
    rolloutPath: rollout,
    token,
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };
  writeFileSync(statePath, JSON.stringify(state));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, CODEX_REMOTE_STATE_DIR: dir, CODEX_REMOTE_PORT: String(port) },
    stdio: 'ignore'
  });
  const origin = `http://127.0.0.1:${port}`;
  let reader;
  const extraReaders = [];
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { ready = (await fetch(origin + '/health')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'bridge did not start');
    let caughtUp = false;
    for (let i = 0; i < 30; i++) {
      const status = await fetch(origin + '/api/status', { headers: { Cookie: 'codex_remote=' + token } }).then(r => r.json());
      if (status.lastSequence >= 61) { caughtUp = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(caughtUp, true, 'bridge did not scan initial history');
    const activity = await fetch(origin + '/api/chats/' + state.threadId + '/activity', { headers: { Cookie: 'codex_remote=' + token } }).then(r => r.json());
    assert.equal(activity.length, 1);
    assert.equal(activity[0].command, 'printf lazy');
    const chatEvents = await fetch(origin + '/api/events', { headers: { Cookie: 'codex_remote=' + token } }).then(r => r.json());
    assert.equal(chatEvents.some(event => event.kind === 'activity'), false);
    const response = await fetch(origin + '/api/stream', { headers: { Cookie: 'codex_remote=' + token } });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    appendFileSync(rollout, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'text', text: 'Live update' }] } }
    }) + '\n');
    let received = '';
    const deadline = Date.now() + 4000;
    while (!received.includes('Live update') && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('No live stream event')), 4000))
      ]);
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    assert.match(received, /Live update/);
    for (let i = 0; i < 7; i++) {
      const extra = await fetch(origin + '/api/stream', { headers: { Cookie: 'codex_remote=' + token } });
      assert.equal(extra.status, 200);
      extraReaders.push(extra.body.getReader());
    }
    const overflow = await fetch(origin + '/api/stream', { headers: { Cookie: 'codex_remote=' + token } });
    assert.equal(overflow.status, 429);
    const stop = await fetch(origin + '/api/disable', {
      method: 'POST',
      headers: { Cookie: 'codex_remote=' + token, Origin: origin, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(stop.status, 200);
    let disabled = false;
    for (let i = 0; i < 30; i++) {
      const health = await fetch(origin + '/health').then(r => r.json());
      if (!health.enabled && !health.wake) { disabled = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(disabled, true, 'bridge did not release its wake assertion');
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).enabled, false);
    assert.equal((await fetch(origin + '/api/status', { headers: { Cookie: 'codex_remote=' + token } })).status, 403);
  } finally {
    if (reader) await reader.cancel();
    for (const extra of extraReaders) await extra.cancel();
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
    rmSync(dir, { recursive: true, force: true });
  }
});
