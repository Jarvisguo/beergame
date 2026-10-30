const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInContext, createContext } = require('node:vm');
const test = require('node:test');

const name = '<img src=x onerror="window.injected=1"> & \'"';
const escaped = '&lt;img src=x onerror=&quot;window.injected=1&quot;&gt; &amp; &#39;&quot;';
const user = { name, socketId: 'player', role: { name: '零售商', downstream: { name: '客户' } },
  orderHistory: [4, 4], costHistory: [0, 2], inventoryHistory: [12], backlog: 0, inventory: 12, cost: 2 };
const group = { users: [user], cost: 2, costHistory: [0, 2], week: 2, waitingForOrders: [] };

function page(script) {
  const elements = new Map();
  const events = new Map();
  const rows = Array.from({ length: 4 }, () => element());
  function element() {
    return { innerHTML: '', textContent: '', hidden: false, value: '', disabled: false,
      dataset: {}, children: [], handlers: {},
      addEventListener(event, handler) { this.handlers[event] = handler; },
      appendChild(child) { this.children.push(child); },
      querySelectorAll() { return rows; }, focus() {} };
  }
  function get(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  }
  const storage = new Map();
  const socket = { on(event, handler) { events.set(event, handler); },
    emit(_event, _password, callback) { callback({ status: 'waiting', groups: [], numUsers: 0 }); } };
  const context = createContext({
    document: { querySelector: get, getElementById: id => get('#' + id), createElement: element, addEventListener() {} },
    window: { addEventListener() {} }, io: () => socket,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setTimeout() {}, clearTimeout() {}, console,
  });
  runInContext(script, context);
  return { context, get, rows, events, storage };
}

function assertSafe(html) {
  assert.ok(!html.includes('<img'), 'player names must not create HTML elements');
  assert.ok(html.includes(escaped), 'player names must be displayed as escaped text');
}

test('admin table treats player names as text', () => {
  const p = page(readFileSync('public/admin.js', 'utf8'));
  p.context.fixture = group;
  runInContext('refreshTable([fixture], false)', p.context);
  assertSafe(p.get('#adminTbody').children[0].innerHTML);
});

test('all player table branches treat player names as text', () => {
  const p = page(readFileSync('public/game.js', 'utf8'));
  p.context.fixture = { ...group, users: [user, user, { ...user, socketId: undefined }] };
  runInContext('curGroup = fixture; curWeek = 1; userIdx = 0; updateGroupTable()', p.context);
  p.rows.slice(0, 3).forEach(row => assertSafe(row.innerHTML));
});

test('report tables treat player names as text', () => {
  const html = readFileSync('public/report.html', 'utf8');
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .find(match => match[1].includes('function generateReport()'))[1];
  const p = page(script);
  p.storage.set('beerGameGroup', JSON.stringify([{ ...group, week: 27 }]));
  runInContext('generateReport()', p.context);
  assertSafe(p.get('#groupsContainer').innerHTML);
});

test('admin reconnect requires login and closes the AI modal without retaining a password', () => {
  const p = page(readFileSync('public/admin.js', 'utf8'));
  p.get('#passwordInput').value = 'test-password';
  p.get('#btnAdmin').handlers.click();
  assert.equal(p.get('#adminLogin').hidden, true);
  assert.equal(p.get('#passwordInput').value, '');
  runInContext('startGameUI(0)', p.context);
  assert.equal(p.get('#btnStartGame').disabled, true);
  for (const event of ['disconnect', 'connect']) {
    p.get('#groupPanel').hidden = false;
    p.get('#agentModal').hidden = false;
    runInContext('agentTarget = { groupIndex: 0, roleIndex: 1 }', p.context);
    assert.equal(typeof p.events.get(event), 'function', `${event} must restore the login screen`);
    p.events.get(event)();
    assert.equal(p.get('#adminLogin').hidden, false);
    assert.equal(p.get('#groupPanel').hidden, true);
    assert.equal(p.get('#agentModal').hidden, true);
    assert.equal(runInContext('agentTarget', p.context), null);
  }
  p.get('#btnAdmin').handlers.click();
  assert.equal(p.get('#adminLogin').hidden, true);
  assert.equal(p.get('#groupPanel').hidden, false);
  assert.equal(p.get('#gameSettings').hidden, false, 'server restart must restore game settings');
  assert.equal(p.get('#btnStartGame').disabled, false, 'server restart must allow starting a new game');
  assert.equal(p.get('#btnEndGame').hidden, true);
  assert.equal(p.get('#btnResetGame').hidden, true);
});
