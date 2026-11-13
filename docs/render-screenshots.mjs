// Render synthetic examples from the real web.html styles at an iPhone-sized viewport.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scriptTag = '<script src="/app.js?v=activity-popover-1"></script>';
const page = await readFile(join(root, 'web.html'), 'utf8');
if (!page.includes(scriptTag)) throw new Error('Could not find the app script tag in web.html');

const fixture = `<script>
document.getElementById('chat-id').textContent = 'Chat 8d2f6a41';
document.getElementById('status').textContent = 'Completed · Mac awake';
document.getElementById('feed').innerHTML = \
\`<article class="entry user"><div class="entry-head"><span class="who">You</span><time>10:42</time></div><div class="entry-body markdown"><p>Make the remote page easier to use on my phone. Keep commands out of the main chat.</p></div></article>
<details class="entry assistant" open><summary><span class="who">Codex update</span><time>10:43</time><span class="toggle" aria-hidden="true"></span></summary><div class="entry-body markdown"><p>I’m tightening the phone layout and moving activity into an on-demand panel.</p></div></details>
<details class="entry assistant" open><summary><span class="who">Codex reply</span><time>10:44</time><span class="toggle" aria-hidden="true"></span></summary><div class="entry-body markdown"><p>Updated the remote page:</p><ul><li>Messages fit the phone width.</li><li>Commands and file changes stay in Activity logs.</li><li>The same bookmark opens your enabled chats.</li></ul><p>The Mac stays awake while remote access is active.</p></div></details>\`;
document.getElementById('activity-status').textContent = '3 recent logs';
document.getElementById('activity-list').innerHTML = \
\`<details class="entry tool"><summary><span class="who">Command</span><time>10:43</time><span class="toggle" aria-hidden="true"></span></summary><div class="entry-body"><pre><code>$ npm test</code></pre></div></details>
<details class="entry tool"><summary><span class="who">Files changed</span><time>10:43</time><span class="toggle" aria-hidden="true"></span></summary><div class="entry-body"><pre><code>web.html</code></pre></div></details>
<details class="entry tool"><summary><span class="who">Command</span><time>10:44</time><span class="toggle" aria-hidden="true"></span></summary><div class="entry-body"><pre><code>$ node --check app.js</code></pre></div></details>\`;
if (location.hash === '#activity') {
  document.getElementById('activity-panel').hidden = false;
  document.getElementById('activity-toggle').setAttribute('aria-expanded', 'true');
}
</script>`;

const temporary = await mkdtemp(join(tmpdir(), 'codex-remote-screenshots-'));
const profile = join(temporary, 'chrome');
const mock = join(temporary, 'mock.html');
await writeFile(mock, page.replace(scriptTag, fixture));
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: 'ignore' });

try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  if (!port) throw new Error('Chrome did not start its debugging port');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    if (!pending.has(response.id)) return;
    const { resolve, reject } = pending.get(response.id);
    pending.delete(response.id);
    response.error ? reject(new Error(response.error.message)) : resolve(response.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  for (const [name, hash] of [['chat.png', ''], ['activity.png', '#activity']]) {
    await call('Page.navigate', { url: pathToFileURL(mock).href + hash });
    await new Promise(resolve => setTimeout(resolve, 250));
    if (hash) await call('Runtime.evaluate', { expression: "document.getElementById('activity-panel').hidden = false" });
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(root, 'docs', 'images', name), Buffer.from(data, 'base64'));
  }
  socket.close();
} finally {
  child.kill();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
