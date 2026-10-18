// The capability never enters storage, a request URL, or the embedded player.
let capability = new URLSearchParams(window.location.hash.slice(1)).get('control') || '';
if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);

const element = (id) => document.getElementById(id);
const player = element('player');
const hostPanel = element('host-panel');
let current = null;
let hostSessionId = null;
let hostCheck = false;
let keyboardEnabled = false;
let sending = false;
let nextControlAt = 0;
let playerAddress = '';
let disconnected = false;

async function requestJson(path, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { cache: 'no-store', ...options, signal: controller.signal });
    const result = await response.json();
    return { response, result };
  } finally { window.clearTimeout(timer); }
}

function announce(message, isError = false) {
  const target = hostPanel.hidden ? element('page-message') : element('control-message');
  target.textContent = message;
  target.hidden = !message;
  target.classList.toggle('error', isError);
}

function forgetHost(message) {
  capability = '';
  hostSessionId = null;
  keyboardEnabled = false;
  hostPanel.hidden = true;
  element('role').textContent = 'WATCHING TOGETHER';
  if (message) announce(message);
}

function frameAddress(url) {
  const address = new URL(url);
  if (!['http:', 'https:'].includes(address.protocol)) throw new Error('Unsupported stream address.');
  if (!address.pathname.endsWith('/')) address.pathname += '/';
  address.searchParams.set('controls', 'true');
  address.searchParams.set('autoplay', 'false');
  address.searchParams.set('muted', 'false');
  address.searchParams.set('playsinline', 'true');
  return address.href;
}

function showStream(status, force = false) {
  const url = status.active ? status.streamUrl : null;
  const openStream = element('open-stream');
  const reconnect = element('reconnect');
  let address = '';
  let message = status.active ? 'This host has not configured a browser stream.' : 'The game stream will appear here.';
  if (url) {
    try {
      address = frameAddress(url);
      openStream.href = address;
      if (window.location.protocol === 'https:' && new URL(address).protocol !== 'https:') {
        address = '';
        message = 'This room uses HTTPS, so its embedded stream also needs HTTPS. You can open the player separately.';
      }
    } catch { message = 'The stream address could not be opened.'; }
  }
  openStream.hidden = !url;
  reconnect.disabled = !address;
  player.hidden = !address;
  element('player-placeholder').hidden = Boolean(address);
  element('player-heading').textContent = status.active ? 'Waiting for the big screen.' : "Your party's on its way.";
  element('player-message').textContent = message;
  element('playback-note').textContent = address ? 'Press play in the player to enable video and sound.' : status.active ? 'Stream unavailable in this page.' : 'Waiting for a game.';
  if (address !== playerAddress || force) {
    playerAddress = address;
    if (address) player.src = address;
    else player.removeAttribute('src');
  }
}

async function checkHost(sessionId) {
  if (!capability || hostCheck || hostSessionId === sessionId) return;
  hostCheck = true;
  try {
    const { response, result: host } = await requestJson('/api/host', { headers: { Authorization: `Bearer ${capability}` } });
    if (!response.ok) {
      if ([401, 403, 409].includes(response.status)) forgetHost('This host link has expired. Use the link for the current game.');
      return;
    }
    if (current?.active && current.sessionId === host.sessionId && capability) {
      hostSessionId = host.sessionId;
      hostPanel.hidden = false;
      element('role').textContent = 'HOST MODE';
      element('page-message').hidden = true;
    }
  } catch { announce('Host controls could not connect. Retrying shortly.', true); }
  finally { hostCheck = false; }
}

async function poll() {
  try {
    const { response, result: status } = await requestJson('/api/status');
    if (!response.ok) throw new Error('Status unavailable');
    if (disconnected) {
      disconnected = false;
      announce('Connection restored.');
    }
    if (hostSessionId && (!status.active || status.sessionId !== hostSessionId)) forgetHost('The game ended. Each new game has its own host link.');
    const changed = current?.sessionId !== status.sessionId;
    current = status;
    element('connection').classList.toggle('live', status.active);
    element('connection').classList.remove('offline');
    element('connection-label').textContent = !status.active ? 'Room ready' : status.phase === 'starting' ? 'Starting game' : status.phase === 'stopping' ? 'Ending game' : status.phase === 'error' ? 'Game needs attention' : 'Game running';
    element('game-title').textContent = status.active ? status.game || 'Game night is on.' : 'Make room for some fun.';
    element('pack-name').textContent = status.active ? status.pack || 'NOW PLAYING' : 'YOUR NEXT GREAT GAME NIGHT';
    element('game-description').textContent = status.active ? 'Watch here. Play on your phone. Everyone brings the fun.' : 'The party starts when your host launches a game in Discord.';
    element('room-code').textContent = status.roomCode || '— — — —';
    element('room-code-note').textContent = status.roomCode ? 'Enter this code at jackbox.tv' : status.active ? 'Use the code shown in the game' : 'Waiting for the lobby';
    const waiting = Boolean(status.phase && status.phase !== 'running');
    for (const button of document.querySelectorAll('[data-key]')) button.disabled = waiting;
    element('keyboard-toggle').disabled = waiting;
    if (waiting && keyboardEnabled) {
      keyboardEnabled = false;
      element('keyboard-toggle').setAttribute('aria-pressed', 'false');
      element('keyboard-toggle').textContent = 'Enable keyboard';
    }
    element('save-menu').disabled = waiting || ['replaying', 'saved', 'ready'].includes(status.menuStatus);
    element('save-menu').textContent = status.menuStatus === 'replaying' ? 'Replaying menu steps…' : ['saved', 'ready'].includes(status.menuStatus) ? 'Menu steps saved' : 'Save menu steps';
    showStream(status, changed);
    if (status.active) await checkHost(status.sessionId);
  } catch {
    disconnected = true;
    element('connection').classList.remove('live');
    element('connection').classList.add('offline');
    element('connection-label').textContent = 'Reconnecting';
    announce('The room is temporarily unreachable. Reconnecting automatically…', true);
  } finally { window.setTimeout(poll, 2500); }
}

async function sendControl(path, body) {
  if (!capability || !current?.active || hostSessionId !== current.sessionId || sending || Date.now() < nextControlAt) return;
  sending = true;
  nextControlAt = Date.now() + 200;
  hostPanel.classList.add('sending');
  try {
    const { response, result } = await requestJson(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` }, body: JSON.stringify(body),
    }, path === '/api/stop' ? 60_000 : 20_000);
    if (!response.ok) {
      if (response.status === 401 || (response.status === 409 && result.code !== 'GAME_CONTROL')) forgetHost('This host link has expired. Use the link for the current game.');
      else announce(result.error || 'The control could not be sent.', true);
      return;
    }
    if (path === '/api/stop') forgetHost('The game has ended. Launch another game in Discord when you are ready.');
    else announce(result.message || 'Control sent.');
    if (path === '/api/menu') {
      element('save-menu').disabled = true;
      element('save-menu').textContent = 'Menu steps saved';
    }
  } catch { announce('Could not confirm the control. Check the game before trying again.', true); }
  finally { sending = false; hostPanel.classList.remove('sending'); }
}

for (const button of document.querySelectorAll('[data-key]')) button.addEventListener('click', () => sendControl('/api/key', { key: button.dataset.key }));
element('reconnect').addEventListener('click', () => { if (current) showStream(current, true); });
element('save-menu').addEventListener('click', () => sendControl('/api/menu', {}));
element('stop-game').addEventListener('click', () => {
  if (window.confirm('End the current game for everyone?')) sendControl('/api/stop', {});
});
element('keyboard-toggle').addEventListener('click', () => {
  keyboardEnabled = !keyboardEnabled;
  element('keyboard-toggle').setAttribute('aria-pressed', String(keyboardEnabled));
  element('keyboard-toggle').textContent = keyboardEnabled ? 'Disable keyboard' : 'Enable keyboard';
  announce(keyboardEnabled ? 'Arrow keys, Enter, Escape, Space and Tab now control the game. Disable keyboard to navigate the page normally.' : 'Keyboard controls are off.');
});
document.addEventListener('keydown', (event) => {
  if (!keyboardEnabled || hostPanel.hidden || (current?.phase && current.phase !== 'running') || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Escape: 'Escape', ' ': 'space', Tab: 'Tab' }[event.key];
  if (!key) return;
  event.preventDefault();
  sendControl('/api/key', { key });
});
player.addEventListener('error', () => {
  element('playback-note').textContent = 'The player could not load. Reconnect or open the player separately.';
});
poll();
