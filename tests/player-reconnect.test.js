const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { createContext, runInContext } = require('node:vm');
const test = require('node:test');
const { io } = require('socket.io-client');

function page(createSocket) {
  let clock = 0, timerID = 0;
  const timers = new Map(), events = new Map(), documentEvents = new Map(), storage = new Map();
  const element = () => ({ textContent: '', innerHTML: '', value: '', hidden: false, disabled: false,
    style: {}, dataset: {}, handlers: {}, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener(e, h) { this.handlers[e] = h; }, focus() {} });
  const elements = new Map([...readFileSync('public/index.html', 'utf8').matchAll(/\bid="([^"]+)"/g)]
    .map(m => ['#' + m[1], element()]));
  elements.get('#groupTbody').querySelectorAll = () => Array.from({ length: 4 }, element);
  const requests = [];
  const socket = createSocket ? createSocket() : { connected: true, id: 'connection-1', on: (e, h) => events.set(e, h),
    emit: (event, name, callback) => requests.push({ event, name, callback }), connect() {} };
  const document = { visibilityState: 'visible', querySelector: s => elements.get(s),
    addEventListener: (e, h) => documentEvents.set(e, h) };
  const context = createContext({ document, window: {}, console, io: () => socket,
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    setTimeout(fn, delay) { const id = ++timerID; timers.set(id, { at: clock + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  runInContext(readFileSync('public/game.js', 'utf8'), context);
  const response = (groupNumber = 2) => ({ idx: 1, groupNumber, numUsers: 8, gameEnded: false,
    group: { week: 3, waitingForOrders: ['零售商', '区域仓库', '工厂'], users: [
      { name: 'teammate', role: { name: '零售商' }, orderHistory: [] },
      { name: 'returning-player', socketId: socket.id, inventory: 9, backlog: 0, cost: 7,
        orderHistory: [4, 5], costHistory: [2, 7], role: { name: '批发商', upstream: { name: '区域仓库', shipments: 4 },
          downstream: { name: '零售商', orders: 5, shipments: 5 } } },
    ] } });
  const get = id => elements.get('#' + id);
  function click(id) { get(id).handlers.click({ preventDefault() {} }); }
  function loggedIn() { get('usernameInput').value = 'returning-player'; click('btnLogin'); requests.at(-1).callback(response()); }
  function disconnect() { socket.connected = false; events.get('disconnect')(); }
  function connect() { socket.id += '-new'; socket.connected = true; events.get('connect')(); }
  function tick(ms) {
    const target = clock + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    clock = target;
  }
  return { requests, socket, get, click, loggedIn, disconnect, connect, tick, response, events,
    visible: () => documentEvents.get('visibilitychange')(), storage };
}

test('an interrupted restore is retried; late replies cannot overwrite the restored seat', () => {
  const p = page(); p.loggedIn(); p.visible(); const oldRequest = p.requests.at(-1);
  p.disconnect(); p.connect();
  assert.equal(p.requests.length, 3);
  assert.notEqual(p.get('connBar').textContent, '🟢 在线');
  p.requests.at(-1).callback(p.response(2)); oldRequest.callback(p.response(99));
  assert.equal(p.get('userGroup').textContent, '第 2 组');
  assert.equal(p.get('flowCard').dataset.flowState, 'waiting-others');
  assert.equal(p.get('connBar').textContent, '🟢 在线');
});

test('a lost manual login reply does not lock the button or lose the attempted username', () => {
  const p = page(); p.get('usernameInput').value = 'returning-player'; p.click('btnLogin');
  p.disconnect(); assert.equal(p.get('btnLogin').disabled, false); p.connect();
  assert.equal(p.requests.length, 2); assert.equal(p.requests.at(-1).name, 'returning-player');
  p.requests.at(-1).callback(p.response()); assert.equal(p.get('loginModal').hidden, true);
});

test('timeout permits bounded automatic retries and an explicit retry without refreshing', () => {
  const p = page(); p.get('usernameInput').value = 'returning-player'; p.click('btnLogin');
  const stale = p.requests.at(-1); p.tick(8000);
  assert.equal(p.get('btnLogin').disabled, false); assert.equal(p.get('loginErr').hidden, false);
  p.tick(1000); assert.equal(p.requests.length, 2);
  p.requests.at(-1).callback('Game Started'); p.tick(3000); assert.equal(p.requests.length, 3);
  p.requests.at(-1).callback(p.response()); stale.callback(p.response(99));
  assert.equal(p.get('userGroup').textContent, '第 2 组'); p.visible();
  for (let i = 0; i < 6; i++) { p.requests.at(-1).callback('Game Started'); p.tick(50000); }
  const count = p.requests.length; p.tick(600000); assert.equal(p.requests.length, count);
  assert.equal(p.get('btnReconnect').hidden, false); p.click('btnReconnect'); assert.equal(p.requests.length, count + 1);
});

test('reset cancels pending replies and retries, including the cached username', () => {
  const p = page(); p.loggedIn(); p.visible(); const stale = p.requests.at(-1);
  p.events.get('game reset')(); stale.callback(p.response()); p.tick(600000);
  assert.equal(p.get('mainApp').hidden, true); assert.equal(p.get('loginModal').hidden, false);
  assert.equal(p.storage.has('bdg_username'), false);
});

test('the default reservation is ten minutes and remains configurable', () => {
  for (const [value, expected] of [[undefined, 600000], ['invalid', 600000], ['1200', 1200]]) {
    const env = { ...process.env };
    if (value === undefined) delete env.MOBILE_RECONNECT_GRACE_MS; else env.MOBILE_RECONNECT_GRACE_MS = value;
    const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e',
      "process.stdout.write(String(require('./src/config.ts').RECONNECT_GRACE_MS))"], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(Number(result.stdout), expected);
  }
});

test('real frontend/server restore group, seat and orders within grace; expiry still releases the seat', { timeout: 25000 }, async () => {
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const child = spawn(process.execPath, ['index.js'], { env: { ...process.env, PORT: String(port),
    ADMIN_PASSWORD: 'reconnect-test-only', MOBILE_RECONNECT_GRACE_MS: '1200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sockets = [];
  const emit = (s, e, ...args) => new Promise((resolve, reject) => s.timeout(700).emit(e, ...args, (err, msg) => err ? reject(err) : resolve(msg)));
  async function connect() {
    const s = io(`http://127.0.0.1:${port}`, { autoConnect: false, reconnection: false, timeout: 2000 }); sockets.push(s);
    const ready = once(s, 'connect'); s.connect(); await ready; return s;
  }
  const pause = ms => new Promise(r => setTimeout(r, ms));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup timeout')), 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('server exited: ' + code)); });
      child.stdout.on('data', d => { if (d.toString().includes('http://0.0.0.0:')) { clearTimeout(timer); resolve(); } });
    });
    const admin = await connect(); await emit(admin, 'submit password', 'reconnect-test-only'); await emit(admin, 'start game');
    const players = [];
    for (let i = 0; i < 8; i++) { const s = await connect(); players.push(s); await emit(s, 'submit username', `seat-${i}`); }
    for (const s of players.slice(4)) await emit(s, 'submit order', '5');
    await emit(players[5], 'submit order', '8');
    const snapshot = (await emit(admin, 'submit password', 'reconnect-test-only')).groups[1];
    const duplicate = await emit(players[5], 'submit username', 'seat-5');
    assert.equal(duplicate.groupNumber, 2); assert.equal(duplicate.idx, 1); assert.equal(duplicate.group.week, 2);
    assert.deepEqual(duplicate.group, snapshot, 'duplicate login is read-only');
    assert.ok((await emit(players[5], 'submit username', 'other-name')).err);
    const other = await connect(); assert.equal(await emit(other, 'submit username', 'seat-5'), 'Game Started');
    players[5].disconnect();
    const newcomer = await connect(); assert.equal((await emit(newcomer, 'submit username', 'newcomer')).groupNumber, 3);
    const returned = await connect(); const restored = await emit(returned, 'submit username', 'seat-5');
    assert.equal(restored.reconnected, true); assert.equal(restored.groupNumber, 2); assert.equal(restored.idx, 1);
    const withoutConnection = u => { const { socketId, disconnectedAt, ...rest } = u; return rest; };
    assert.deepEqual(withoutConnection(restored.group.users[1]), withoutConnection(snapshot.users[1]));
    assert.deepEqual(restored.group.waitingForOrders, snapshot.waitingForOrders);
    assert.match((await emit(returned, 'submit order', '9')).err, /已提交/);
    await pause(1400);
    assert.equal((await emit(returned, 'submit username', 'seat-5')).numUsers, 9, 'old disconnect timer was cancelled');
    returned.disconnect();
    const livePage = page(() => {
      const s = io(`http://127.0.0.1:${port}`, { autoConnect: false, reconnectionDelay: 20, reconnectionDelayMax: 20 });
      sockets.push(s); return s;
    });
    async function waitFor(check) {
      const deadline = Date.now() + 2000;
      while (!check()) { if (Date.now() > deadline) throw new Error('frontend recovery timed out'); await pause(10); }
    }
    const connected = once(livePage.socket, 'connect'); livePage.socket.connect(); await connected;
    livePage.get('usernameInput').value = 'seat-5'; livePage.click('btnLogin');
    await waitFor(() => livePage.get('loginModal').hidden);
    for (let i = 0; i < 3; i++) {
      livePage.visible(); await waitFor(() => livePage.get('connBar').textContent === '🟢 在线');
      const reconnected = once(livePage.socket, 'connect'); livePage.socket.io.engine.close(); await reconnected;
      await waitFor(() => livePage.get('connBar').textContent === '🟢 在线');
      assert.equal(livePage.get('userGroup').textContent, '第 2 组');
      assert.equal(livePage.get('flowCard').dataset.flowState, 'waiting-others');
      assert.match((await emit(livePage.socket, 'submit order', '9')).err, /已提交/);
    }
    livePage.socket.disconnect();
    for (const i of [4, 6, 7]) await emit(players[i], 'submit order', '6');
    const nextWeekSocket = await connect(); const nextWeek = await emit(nextWeekSocket, 'submit username', 'seat-5');
    assert.equal(nextWeek.groupNumber, 2); assert.equal(nextWeek.idx, 1); assert.equal(nextWeek.group.week, 3);
    assert.deepEqual(nextWeek.group.users[1].orderHistory, [5, 8]); assert.ok(nextWeek.group.waitingForOrders.includes('批发商'));
    nextWeekSocket.disconnect(); await pause(1400);
    const replacement = await connect(); const replaced = await emit(replacement, 'submit username', 'after-expiry');
    assert.equal(replaced.groupNumber, 2); assert.equal(replaced.idx, 1); assert.equal(replaced.reconnected, false);
  } finally {
    sockets.forEach(s => s.close());
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
});
