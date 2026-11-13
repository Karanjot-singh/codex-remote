import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const stateDir = process.env.CODEX_REMOTE_STATE_DIR || join(homedir(), '.local', 'state', 'codex-remote');
export const statePath = join(stateDir, 'enabled.json');
export const registryPath = join(stateDir, 'sessions.json');
export const host = '127.0.0.1';
export const port = Number(process.env.CODEX_REMOTE_PORT || 8765);
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const codexBin = process.env.CODEX_REMOTE_CODEX_BIN || process.env.CODEX_APP_RUNTIME_CLI_PATH || (existsSync(bundledCodex) ? bundledCodex : 'codex');
export const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');

export function validThreadId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function readState() {
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf8'));
    const validExpiry = typeof data.expiresAt === 'string' && Date.parse(data.expiresAt) > Date.now();
    return data.enabled && validExpiry && validThreadId(data.threadId) && typeof data.rolloutPath === 'string' ? data : null;
  } catch {
    return null;
  }
}

function validSession(data) {
  return Boolean(data?.enabled && validThreadId(data.threadId) && typeof data.rolloutPath === 'string' &&
    typeof data.token === 'string' && data.token.length >= 12 &&
    typeof data.expiresAt === 'string' && Date.parse(data.expiresAt) > Date.now());
}

export function readRegistry() {
  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (registry.version !== 1 || !registry.sessions || typeof registry.sessions !== 'object') return { version: 1, sessions: {} };
    return { version: 1, sessions: Object.fromEntries(Object.entries(registry.sessions).filter(([id, session]) => id === session?.threadId && validSession(session))) };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { version: 1, sessions: {} };
    const legacy = readState();
    return { version: 1, sessions: legacy ? { [legacy.threadId]: legacy } : {} };
  }
}

export function writeRegistry(data) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const tmp = join(stateDir, '.sessions-' + randomUUID());
  writeFileSync(tmp, JSON.stringify({ version: 1, sessions: data.sessions }) + '\n', { mode: 0o600 });
  renameSync(tmp, registryPath);
  chmodSync(registryPath, 0o600);
  try {
    const legacy = JSON.parse(readFileSync(statePath, 'utf8'));
    if (legacy.enabled) writeState({ ...legacy, enabled: false, migratedAt: new Date().toISOString() });
  } catch {}
}

export function writeState(data) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const tmp = join(stateDir, '.enabled-' + randomUUID());
  writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  renameSync(tmp, statePath);
  chmodSync(statePath, 0o600);
}

export function rolloutPathForThread(threadId) {
  if (!validThreadId(threadId)) throw new Error('Invalid thread ID');
  const db = join(codexHome, 'state_5.sqlite');
  const query = "SELECT rollout_path FROM threads WHERE id='" + threadId + "' LIMIT 1";
  const path = execFileSync('sqlite3', ['-noheader', db, query], { encoding: 'utf8', timeout: 3000 }).trim();
  if (!path || !existsSync(path) || !path.startsWith(join(codexHome, 'sessions') + '/')) {
    throw new Error('Current thread rollout is unavailable');
  }
  return path;
}

export function displayText(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/&#x20;|&#32;|&nbsp;|\u00a0/gi, ' ');
}

function messageText(content) {
  return Array.isArray(content)
    ? content.filter(v => ['text', 'Text'].includes(v?.type) && typeof v.text === 'string').map(v => v.text).join('\n')
    : '';
}

function excerpt(value, limit = 12000) {
  const clean = displayText(value);
  return clean.length > limit ? '… [earlier output omitted]\n' + clean.slice(-limit) : clean;
}

function commandText(value) {
  if (!Array.isArray(value)) return displayText(value).slice(0, 4000);
  if (value.length === 3 && /(?:^|\/)(?:bash|zsh|sh)$/.test(value[0]) && ['-c', '-lc'].includes(value[1])) {
    return displayText(value[2]).slice(0, 4000);
  }
  return displayText(value.map(part => JSON.stringify(part)).join(' ')).slice(0, 4000);
}

export function activityEvent(raw) {
  const payload = raw?.payload;
  if (raw?.type !== 'event_msg' || payload?.type !== 'item_completed') return null;
  const item = payload.item;
  const base = { time: raw.timestamp || null, status: item?.status || 'completed' };
  if (item?.type === 'CommandExecution') {
    return { ...base, activity: 'CommandExecution', command: commandText(item.command), cwd: displayText(item.cwd).slice(0, 1000), exitCode: item.exit_code ?? null, output: excerpt(item.aggregated_output) };
  }
  if (item?.type === 'FileChange') {
    return { ...base, activity: 'FileChange', files: Object.keys(item.changes || {}).slice(0, 30).map(displayText), output: excerpt([item.stdout, item.stderr].filter(Boolean).join('\n')) };
  }
  if (item?.type === 'McpToolCall') {
    return { ...base, activity: 'McpToolCall', tool: displayText([item.server, item.tool].filter(Boolean).join('/')).slice(0, 300), output: excerpt(JSON.stringify(item.result || '', null, 2)) };
  }
  return null;
}

export function publicEvent(raw, seq) {
  const p = raw?.payload;
  if (raw?.type !== 'event_msg' || !p || typeof p !== 'object') return null;
  const timed = raw.timestamp ? { time: raw.timestamp } : {};
  if (p.type === 'task_started') return { seq, kind: 'started', time: raw.timestamp || null, turnId: p.turn_id };
  if (p.type === 'task_complete') return { seq, kind: 'completed', time: raw.timestamp || null, turnId: p.turn_id };
  if (p.type !== 'item_completed' || !p.item) return null;
  const item = p.item;
  if (item.type === 'AgentMessage') {
    if (!['commentary', 'final_answer'].includes(item.phase)) return null;
    const content = messageText(item.content);
    if (!content) return null;
    return { seq, kind: 'message', phase: item.phase || '', text: displayText(content).slice(0, 20000), turnId: p.turn_id, ...timed };
  }
  if (item.type === 'UserMessage') {
    const content = messageText(item.content);
    if (content) return { seq, kind: 'user_message', text: displayText(content).slice(0, 20000), turnId: p.turn_id, ...timed };
    return null;
  }
  return null;
}

export function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}
