const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { createContext, runInContext } = require('node:vm');
const test = require('node:test');
const { io } = require('socket.io-client');

function playerPage() {
  const element = () => ({ textContent: '', innerHTML: '', value: '', hidden: false, disabled: false,
    style: {}, dataset: {}, classList: { toggle() {} }, addEventListener() {}, focus() {} });
  const elements = new Map([...readFileSync('public/index.html', 'utf8').matchAll(/\bid="([^"]+)"/g)]
    .map(match => ['#' + match[1], element()]));
  elements.get('#groupTbody').querySelectorAll = () => Array.from({ length: 4 }, element);
  const events = new Map();
  const socket = { connected: true, on: (event, handler) => events.set(event, handler), emit() {} };
  const context = createContext({
    document: { querySelector: selector => elements.get(selector) || null, addEventListener() {} },
    window: {}, io: () => socket,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout() {}, clearTimeout() {}, console,
  });
  runInContext(readFileSync('public/game.js', 'utf8'), context);
  const user = { name: 'player', socketId: 'test', role: { name: '零售商',
    upstream: { name: '批发商', shipments: 4 }, downstream: { name: '客户', orders: 4 } },
    cost: 0, inventory: 12, backlog: 0, orderHistory: [] };
  const login = number => ({ idx: 0, groupNumber: number, numUsers: 1,
    group: { week: 0, users: [user], waitingForOrders: [] }, gameEnded: false });
  function apply(number) {
    context.response = login(number);
    runInContext('applyLoginState(response)', context);
  }
  function label(number) {
    const badge = elements.get('#userGroup');
    assert.ok(badge, 'the player header must include a group number');
    assert.equal(badge.textContent, `第 ${number} 组`);
    assert.equal(badge.hidden, false);
  }
  return { context, elements, socket, events, login, apply, label };
}

test('player header shows the assigned group and restores it on reconnect', () => {
  const page = playerPage();
  page.apply(1);
  page.label(1);
  page.apply(2);
  page.label(2);
  page.socket.emit = (event, name, callback) => {
    assert.equal(event, 'submit username');
    callback({ ...page.login(3), reconnected: true });
  };
  page.events.get('connect')();
  page.label(3);
});

test('group renumbering updates the label; reset and removal clear it', () => {
  for (const resetEvent of ['game reset', 'kicked out']) {
    const page = playerPage();
    page.apply(2);
    page.events.get('change group subscription')(0);
    page.label(1);
    page.events.get(resetEvent)();
    assert.equal(page.elements.get('#userGroup').hidden, true);
    assert.equal(page.elements.get('#userGroup').textContent, '');
  }
});

test('a missing or invalid group number is not shown as a made-up group', () => {
  const page = playerPage();
  for (const number of [undefined, 0, -1, 1.5, '2']) {
    page.apply(1);
    page.apply(number);
    assert.equal(page.elements.get('#userGroup').hidden, true);
    assert.equal(page.elements.get('#userGroup').textContent, '');
  }
});

test('login returns the same one-based group number as the admin group list', { timeout: 20000 }, async () => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: 'group-test-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  const emit = (socket, event, ...args) => new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, ...args, (error, payload) => error ? reject(error) : resolve(payload));
  });
  async function connect() {
    const socket = io(`http://127.0.0.1:${port}`, { autoConnect: false, reconnection: false, timeout: 3000 });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server startup timed out')), 8000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Test server exited: ${code}`)); });
      child.stdout.on('data', data => {
        if (data.toString().includes('http://0.0.0.0:')) { clearTimeout(timeout); resolve(); }
      });
    });
    const admin = await connect();
    await emit(admin, 'submit password', 'group-test-only');
    await emit(admin, 'start game');
    for (let i = 0; i < 5; i++) {
      const socket = await connect();
      const result = await emit(socket, 'submit username', 'group-player-' + i);
      assert.equal(result.groupNumber, i < 4 ? 1 : 2, 'groups are displayed starting at 1');
    }
    sockets.at(-1).disconnect();
    const returned = await connect();
    assert.equal((await emit(returned, 'submit username', 'group-player-4')).groupNumber, 2);
    const moved = new Promise(resolve => returned.once('change group subscription', resolve));
    await emit(admin, 'remove group', '0');
    assert.equal(await moved, 0, 'existing renumbering notification uses a zero-based index');
    returned.disconnect();
    const movedPlayer = await connect();
    assert.equal((await emit(movedPlayer, 'submit username', 'group-player-4')).groupNumber, 1);
  } finally {
    sockets.forEach(socket => socket.close());
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});
