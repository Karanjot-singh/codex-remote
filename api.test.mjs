import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'codex-remote-test-'));
const threadId = '12345678-1234-4123-8123-123456789abc';
const token = 'test-only-token';
const log = join(dir, 'queue-args.json');
const mock = join(dir, 'mock-codex');
writeFileSync(join(dir, 'enabled.json'), JSON.stringify({ enabled: true, threadId, rolloutPath: join(dir, 'rollout.jsonl'), token, expiresAt: new Date(Date.now() + 60000).toISOString() }));
writeFileSync(mock, '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.MOCK_QUEUE_LOG,JSON.stringify(process.argv.slice(2)));\n');
chmodSync(mock, 0o700);
process.env.CODEX_REMOTE_STATE_DIR = dir;
process.env.CODEX_REMOTE_NO_LISTEN = '1';
process.env.CODEX_REMOTE_CODEX_BIN = mock;
process.env.MOCK_QUEUE_LOG = log;
process.env.CODEX_REMOTE_TAILSCALE_LOGIN = 'owner@example.com';
const { handleRequest } = await import('./server.mjs');

function request(method, path, payload, authenticated = true, origin = 'http://127.0.0.1:8765', tailnetLogin) {
  const input = payload == null ? [] : [Buffer.from(JSON.stringify(payload))];
  const req = Readable.from(input);
  req.method = method;
  req.url = path;
  req.headers = {
    host: '127.0.0.1:8765',
    origin,
    'content-type': 'application/json',
    cookie: authenticated ? 'codex_remote=' + token : '',
    ...(tailnetLogin ? { 'tailscale-user-login': tailnetLogin } : {})
  };
  const result = { writableEnded: false, status: null, headers: null, body: '' };
  result.writeHead = (status, headers) => { result.status = status; result.headers = headers; };
  result.write = text => { result.body += text; };
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  result.end = text => {
    if (text) result.body += text.toString();
    result.writableEnded = true;
    done();
  };
  handleRequest(req, result);
  return finished.then(() => result);
}

test('requires enabled link cookie', async () => {
  const r = await request('GET', '/api/status', null, false);
  assert.equal(r.status, 403);
});
test('stable link requires the owner Tailscale identity and an enabled chat', async () => {
  const path = '/remote/' + threadId;
  assert.equal((await request('GET', path, null, false)).status, 403);
  assert.equal((await request('GET', path, null, false, undefined, 'other@example.com')).status, 403);
  const response = await request('GET', path, null, false, undefined, 'owner@example.com');
  assert.equal(response.status, 302);
  assert.equal(response.headers.Location, '/chat/' + threadId);
  assert.match(response.headers['Set-Cookie'], new RegExp('codex_remote_' + threadId));
});
test('one stable home URL opens enabled chats for the owner only', async () => {
  assert.equal((await request('GET', '/remote', null, false)).status, 403);
  const response = await request('GET', '/remote', null, false, undefined, 'owner@example.com');
  assert.equal(response.status, 302);
  assert.equal(response.headers.Location, '/chat/' + threadId);
  assert.match(response.headers['Set-Cookie'][0], new RegExp('codex_remote_' + threadId));
});
test('serves the current thread status', async () => {
  const r = await request('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).threadId, threadId);
});
test('queues a message only for the enabled thread', async () => {
  const r = await request('POST', '/api/message', { prompt: 'Continue the task' });
  assert.equal(r.status, 202);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['queue', '--thread', threadId, '--message', 'Continue the task']);
});
test('queues one phone image as a private local file', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const r = await request('POST', '/api/message', { prompt: 'Inspect this', image: { data: jpeg.toString('base64') } });
  assert.equal(r.status, 202);
  assert.equal(JSON.parse(r.body).imageAccepted, true);
  const args = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(args.slice(0, 4), ['queue', '--thread', threadId, '--message']);
  const path = args[4].match(/Image attached from phone: ([^\n]+)/)?.[1];
  assert.ok(path?.startsWith(join(dir, 'uploads') + '/'));
  assert.deepEqual(readFileSync(path), jpeg);
});
test('rejects invalid phone image data before queueing', async () => {
  const r = await request('POST', '/api/message', { prompt: '', image: { data: Buffer.from('not an image').toString('base64') } });
  assert.equal(r.status, 400);
});
test('rejects cross-origin mutation', async () => {
  const r = await request('POST', '/api/message', { prompt: 'Do something' }, true, 'https://attacker.example');
  assert.equal(r.status, 403);
});
test('requires same origin before ending remote access', async () => {
  const r = await request('POST', '/api/disable', {}, true, 'https://attacker.example');
  assert.equal(r.status, 403);
});
