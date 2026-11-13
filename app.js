const threadId = location.pathname.split('/')[2];
const api = '/api/chats/' + encodeURIComponent(threadId);
const feed = document.getElementById('feed');
const statusEl = document.getElementById('status');
const chatIdEl = document.getElementById('chat-id');
const notice = document.getElementById('notice');
const form = document.getElementById('form');
const promptEl = document.getElementById('prompt');
const sendButton = document.getElementById('send');
const endButton = document.getElementById('end-session');
const dialog = document.getElementById('stop-dialog');
const confirmEnd = document.getElementById('confirm-end');
const cancelEnd = document.getElementById('cancel-end');
const dialogError = document.getElementById('dialog-error');
const menuButton = document.getElementById('menu-toggle');
const menu = document.getElementById('menu');
const menuList = document.getElementById('menu-list');
const activityToggle = document.getElementById('activity-toggle');
const activityPanel = document.getElementById('activity-panel');
const activityList = document.getElementById('activity-list');
const activityStatus = document.getElementById('activity-status');
const refreshActivity = document.getElementById('refresh-activity');
const pickImage = document.getElementById('pick-image');
const imageInput = document.getElementById('image-input');
const imagePreview = document.getElementById('image-preview');
const removeImage = document.getElementById('remove-image');
const imageTools = document.getElementById('image-tools');
let last = 0;
let source;
let pollTimer;
let ended = false;
let activityLoad = 0;
let selectedImage = null;
let previewUrl = null;

chatIdEl.textContent = 'Chat ' + threadId.slice(0, 8);

function timeNode(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const node = document.createElement('time');
  node.dateTime = value;
  node.textContent = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return node;
}

function header(parent, label, preview, time) {
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = label;
  parent.append(who);
  if (preview) {
    const short = document.createElement('span');
    short.className = 'preview';
    short.textContent = preview;
    parent.append(short);
  }
  const stamp = timeNode(time);
  if (stamp) parent.append(stamp);
}

function addToggle(summary) {
  const toggle = document.createElement('span');
  toggle.className = 'toggle';
  toggle.setAttribute('aria-hidden', 'true');
  summary.append(toggle);
}

function appendInline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(position, match.index)));
    const token = match[0];
    let node;
    if (token.startsWith('`')) {
      node = document.createElement('code');
      node.textContent = token.slice(1, -1);
    } else if (token.startsWith('**')) {
      node = document.createElement('strong');
      node.textContent = token.slice(2, -2);
    } else {
      const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      node = document.createElement('a');
      node.textContent = parts[1];
      node.href = parts[2];
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
    parent.append(node);
    position = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}

function renderMarkdown(text) {
  const result = document.createDocumentFragment();
  const lines = text.split('\n');
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const node = document.createElement('p');
    appendInline(node, paragraph.join('\n'));
    result.append(node);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const pre = document.createElement('pre');
      const inner = document.createElement('code');
      inner.textContent = code.join('\n');
      pre.append(inner);
      result.append(pre);
    } else if (!line.trim()) {
      flush();
    } else if (/^#{1,3}\s+/.test(line)) {
      flush();
      const level = line.match(/^#+/)[0].length;
      const heading = document.createElement('h' + level);
      appendInline(heading, line.replace(/^#{1,3}\s+/, ''));
      result.append(heading);
    } else if (/^\s*(?:[-*]\s+|\d+\.\s+)/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))) {
        const item = document.createElement('li');
        appendInline(item, lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        list.append(item);
        i++;
      }
      i--;
      result.append(list);
    } else if (/^>\s?/.test(line)) {
      flush();
      const quote = document.createElement('blockquote');
      appendInline(quote, line.replace(/^>\s?/, ''));
      result.append(quote);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return result;
}

function displayUserText(text) {
  return text.replace(/\\(?=\r?\n)/g, '').replace(/\\([#*-])/g, '$1').trim();
}

function preview(text) {
  const line = text.split('\n').map(x => x.trim()).find(x => x && !x.startsWith('```')) || 'Open to read';
  return line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').slice(0, 150);
}

function addPre(parent, text) {
  if (!text) return;
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.append(code);
  parent.append(pre);
}

function renderActivity(event) {
  const entry = document.createElement('details');
  entry.className = 'entry tool';
  const summary = document.createElement('summary');
  const body = document.createElement('div');
  body.className = 'entry-body';
  if (event.activity === 'CommandExecution') {
    header(summary, 'Command', preview(event.command || '(unavailable)'), event.time);
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = [event.cwd && 'In ' + event.cwd, event.status, event.exitCode == null ? '' : 'exit ' + event.exitCode].filter(Boolean).join(' · ');
    body.append(meta);
    addPre(body, '$ ' + (event.command || '(unavailable)'));
    addPre(body, event.output || '(no output)');
  } else if (event.activity === 'FileChange') {
    header(summary, 'Files changed', (event.files || []).join(', ') || 'Open for details', event.time);
    addPre(body, (event.files || []).join('\n'));
    addPre(body, event.output);
  } else {
    header(summary, 'Tool', event.tool || event.activity, event.time);
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = event.status;
    body.append(meta);
    addPre(body, event.output);
  }
  addToggle(summary);
  entry.append(summary, body);
  activityList.append(entry);
}

async function loadActivity() {
  if (ended || activityPanel.hidden) return;
  const generation = ++activityLoad;
  refreshActivity.disabled = true;
  activityStatus.textContent = 'Loading recent logs…';
  try {
    const response = await fetch(api + '/activity');
    if (!response.ok) throw new Error('Could not load logs');
    const events = await response.json();
    if (generation !== activityLoad || activityPanel.hidden) return;
    activityList.replaceChildren();
    if (!Array.isArray(events) || !events.length) activityStatus.textContent = 'No recent activity';
    else {
      for (const event of events.reverse()) renderActivity(event);
      activityStatus.textContent = events.length + ' recent logs · loaded on request';
    }
  } catch (error) {
    if (generation === activityLoad && !activityPanel.hidden) activityStatus.textContent = error.message;
  } finally {
    if (generation === activityLoad) refreshActivity.disabled = false;
  }
}

function closeActivity() {
  if (activityPanel.hidden) return;
  activityPanel.hidden = true;
  activityToggle.setAttribute('aria-expanded', 'false');
  activityToggle.setAttribute('aria-label', 'Show activity logs');
  activityLoad++;
  activityList.replaceChildren();
  activityStatus.textContent = 'Not loaded';
  refreshActivity.disabled = false;
}

activityToggle.addEventListener('click', () => {
  if (!activityPanel.hidden) return closeActivity();
  closeMenu();
  activityPanel.hidden = false;
  activityToggle.setAttribute('aria-expanded', 'true');
  activityToggle.setAttribute('aria-label', 'Hide activity logs');
  loadActivity();
});
refreshActivity.addEventListener('click', loadActivity);

function render(event) {
  if (event.seq <= last) return;
  last = event.seq;
  if (event.kind === 'started' || event.kind === 'completed') {
    statusEl.textContent = event.kind === 'started' ? 'Running · Mac awake' : 'Completed · Mac awake';
    return;
  }
  const shouldScroll = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  let entry;
  if (event.kind === 'user_message') {
    entry = document.createElement('article');
    entry.className = 'entry user';
    const head = document.createElement('div');
    head.className = 'entry-head';
    header(head, 'You', '', event.time);
    const body = document.createElement('div');
    body.className = 'entry-body markdown';
    body.append(renderMarkdown(displayUserText(event.text)));
    entry.append(head, body);
  } else if (event.kind === 'message') {
    entry = document.createElement('details');
    entry.className = 'entry assistant';
    entry.open = true;
    const summary = document.createElement('summary');
    header(summary, event.phase === 'final_answer' ? 'Codex reply' : 'Codex update', preview(event.text), event.time);
    addToggle(summary);
    const body = document.createElement('div');
    body.className = 'entry-body markdown';
    body.append(renderMarkdown(event.text));
    entry.append(summary, body);
  }
  if (!entry) return;
  feed.append(entry);
  while (feed.children.length > 120) feed.firstChild.remove();
  if (shouldScroll) feed.scrollTop = feed.scrollHeight;
}

function renderMenu(sessions) {
  menuList.replaceChildren();
  if (!sessions.length) { menuList.textContent = 'No other chats opened on this phone.'; return; }
  for (const session of sessions) {
    const link = document.createElement('a');
    link.href = '/chat/' + session.threadId;
    if (session.threadId === threadId) link.setAttribute('aria-current', 'page');
    link.textContent = 'Chat ' + session.threadId.slice(0, 8);
    const detail = document.createElement('small');
    detail.textContent = session.status + (session.threadId === threadId ? ' · current' : '');
    link.append(detail);
    menuList.append(link);
  }
}

function closeMenu() { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); }
menuButton.addEventListener('click', () => {
  if (menu.hidden) closeActivity();
  menu.hidden = !menu.hidden;
  menuButton.setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', event => {
  if (!menu.hidden && !menu.contains(event.target) && !menuButton.contains(event.target)) closeMenu();
  if (!activityPanel.hidden && !activityPanel.contains(event.target) && !activityToggle.contains(event.target)) closeActivity();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeActivity(); });

function finishEnded(message) {
  ended = true;
  closeActivity();
  if (source) source.close();
  if (pollTimer) clearInterval(pollTimer);
  statusEl.textContent = 'Remote ended';
  notice.textContent = message || 'Remote access ended. Enable this chat again on the Mac for a new link.';
  promptEl.disabled = true;
  sendButton.disabled = true;
  endButton.disabled = true;
  activityToggle.disabled = true;
  pickImage.disabled = true;
}

function clearImage() {
  selectedImage = null;
  imageInput.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  imagePreview.hidden = true;
  imagePreview.removeAttribute('src');
  imageTools.hidden = true;
}

pickImage.addEventListener('click', () => imageInput.click());
removeImage.addEventListener('click', clearImage);
imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  clearImage();
  if (!file) return;
  if (!file.type.startsWith('image/')) { notice.textContent = 'Choose an image file.'; return; }
  selectedImage = file;
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
  imagePreview.hidden = false;
  imageTools.hidden = false;
  notice.textContent = 'Image ready to queue with your message.';
});

async function encodeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Safari could not read this image'));
      image.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    if (!data || data.length > 4 * 1024 * 1024) throw new Error('Image is too large after resizing');
    return { data };
  } finally { URL.revokeObjectURL(url); }
}

async function poll() {
  if (ended) return;
  try {
    const response = await fetch(api + '/status');
    if (response.status === 403) return finishEnded();
    if (!response.ok) throw new Error('Status unavailable');
    const status = await response.json();
    statusEl.textContent = status.status + (status.wake ? ' · Mac awake' : ' · wake unavailable');
    const [events, sessions] = await Promise.all([
      fetch(api + '/events?after=' + last).then(r => r.json()),
      fetch('/api/sessions').then(r => r.json())
    ]);
    if (Array.isArray(events)) events.forEach(render);
    if (Array.isArray(sessions)) renderMenu(sessions);
  } catch { if (!ended) statusEl.textContent = 'Disconnected'; }
}

function connect() {
  source = new EventSource(api + '/stream?after=' + last);
  source.onmessage = event => { try { render(JSON.parse(event.data)); } catch {} };
  source.onerror = () => { if (!ended) statusEl.textContent = 'Reconnecting…'; };
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = promptEl.value.trim();
  if ((!prompt && !selectedImage) || ended) return;
  sendButton.disabled = true;
  notice.textContent = 'Queueing…';
  try {
    const image = selectedImage ? await encodeImage(selectedImage) : null;
    const response = await fetch(api + '/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, image }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    promptEl.value = '';
    clearImage();
    notice.textContent = data.imageAccepted ? 'Message and image queued for this chat.' : 'Queued for this chat. Codex will read it after the current turn.';
  } catch (error) { notice.textContent = error.message; }
  finally { sendButton.disabled = ended; }
});

cancelEnd.addEventListener('click', () => dialog.close());
endButton.addEventListener('click', () => {
  dialogError.textContent = '';
  if (dialog.showModal) dialog.showModal();
  else if (window.confirm('End remote access for this chat? Your Codex chat stays open.')) stopRemote();
});

async function stopRemote() {
  confirmEnd.disabled = true;
  dialogError.textContent = '';
  try {
    const response = await fetch(api + '/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not end this session');
    if (dialog.open) dialog.close();
    finishEnded(data.remainingSessions ? 'This chat is disconnected. Other remote chats remain active.' : 'Remote access ended. Your Mac can sleep normally.');
    const sessions = await fetch('/api/sessions').then(r => r.json());
    if (Array.isArray(sessions)) renderMenu(sessions);
  } catch (error) { dialogError.textContent = error.message; }
  finally { confirmEnd.disabled = false; }
}
confirmEnd.addEventListener('click', stopRemote);

poll();
connect();
pollTimer = setInterval(poll, 30000);
