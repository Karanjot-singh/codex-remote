import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Mac command can end one or all remote sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-remote-control-'));
  const ids = ['12345678-1234-4123-8123-123456789abc', '12345678-1234-4123-8123-123456789abd'];
  const sessions = Object.fromEntries(ids.map((threadId, index) => [threadId, {
    enabled: true, threadId, rolloutPath: join(dir, 'rollout.jsonl'), token: `test-token-long-enough-${index}`, expiresAt: new Date(Date.now() + 60000).toISOString()
  }]));
  const state = join(dir, 'sessions.json');
  writeFileSync(state, JSON.stringify({ version: 1, sessions }));
  const run = args => spawnSync(process.execPath, ['control.mjs', ...args], { cwd: import.meta.dirname, env: { ...process.env, CODEX_REMOTE_STATE_DIR: dir }, encoding: 'utf8' });
  try {
    assert.equal(run(['disable', ids[0]]).status, 0);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(state, 'utf8')).sessions), [ids[1]]);
    assert.equal(run(['disable']).status, 0);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(state, 'utf8')).sessions), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabling an active chat returns its existing link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-remote-enable-'));
  const threadId = '12345678-1234-4123-8123-123456789abc';
  const token = 'existing-token-long-enough';
  const state = join(dir, 'sessions.json');
  writeFileSync(state, JSON.stringify({ version: 1, sessions: {
    [threadId]: { enabled: true, threadId, rolloutPath: join(dir, 'rollout.jsonl'), token, expiresAt: new Date(Date.now() + 60000).toISOString() }
  } }));
  try {
    const result = spawnSync(process.execPath, ['control.mjs', 'enable'], {
      cwd: import.meta.dirname, env: { ...process.env, CODEX_REMOTE_STATE_DIR: dir, CODEX_THREAD_ID: threadId }, encoding: 'utf8'
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp('/s/' + token));
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).sessions[threadId].token, token);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
