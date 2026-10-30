const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createContext, runInContext } = require('node:vm');
const test = require('node:test');

function page(file) {
  const elements = new Map(), events = new Map(), rows = [];
  const element = () => ({ innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, style: {}, dataset: {},
    children: [], classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
    appendChild(child) { this.children.push(child); }, querySelectorAll: () => rows });
  for (let i = 0; i < 4; i++) rows.push(element());
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const ctx = createContext({ document: { querySelector: get, getElementById: id => get('#' + id), createElement: element, addEventListener() {} },
    window: { addEventListener() {} }, io: () => ({ on: (event, handler) => events.set(event, handler), emit() {} }),
    localStorage: { getItem() { return null; }, setItem() {} }, performance: { now: () => 0 },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {}, console });
  runInContext(readFileSync('public/bullwhip.js', 'utf8'), ctx);
  let script = readFileSync(file, 'utf8');
  if (file.endsWith('.html')) script = [...script.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('function generateReport()'))[1];
  runInContext(script, ctx);
  return { ctx, get, events, rows };
}
function fixture(weeks) {
  const demands = Array.from({ length: weeks }, (_, i) => i % 2 ? 8 : 4);
  return { week: weeks + 1, cost: 0, costHistory: Array(weeks).fill(0), waitingForOrders: [],
    users: ['零售商', '批发商', '区域仓库', '工厂'].map((name, i) => ({ name: 'p' + i, socketId: 's' + i,
      role: { name, upstream: { name: '上游', orders: 4, shipments: 4 }, downstream: { name: '下游', orders: 4, shipments: 4 } },
      inventory: 12, backlog: 0, cost: 0, costHistory: Array(weeks).fill(0), orderHistory: demands.map(v => v * 2),
      demandHistory: demands, historyStartWeek: 1 })) };
}

test('player, admin and report show the same variance ratio and level for the same settled weeks', () => {
  const g = fixture(26);
  const player = page('public/game.js'); player.ctx.fixture = g;
  runInContext('curWeek = fixture.week; curGroup = fixture; userIdx = 0; curUser = fixture.users[0]; updateAnalytics(); updateGroupTable()', player.ctx);
  assert.match(player.get('#bullwhip').innerHTML, /4\.00× · 中度放大/);
  assert.match(player.get('#bullwhip').innerHTML, /第 1—26 周/);
  player.rows.forEach(row => assert.match(row.innerHTML, /4\.00× · 中度放大/));
  const admin = page('public/admin.js'); admin.ctx.fixture = g;
  runInContext('refreshTable([fixture], true)', admin.ctx);
  assert.match(admin.get('#adminTbody').children[0].innerHTML, /4\.00× · 中度放大/);
  const report = page('public/report.html'); report.ctx.window.gameGroup = [g];
  runInContext('generateReport()', report.ctx);
  assert.match(report.get('#groupsContainer').innerHTML, /4\.00× · 中度放大/);
  assert.equal(report.get('#maxBullwhipScore').textContent, '4.00×');
});

test('settlement refreshes teammates and own card together without refreshing the browser', () => {
  const player = page('public/game.js'); player.ctx.fixture = fixture(4);
  runInContext('curWeek = fixture.week; curGroup = fixture; userIdx = 0; curUser = fixture.users[0]; updateAnalytics()', player.ctx);
  assert.match(player.get('#bullwhip').innerHTML, /样本积累中：4\/5 周/);
  const next = fixture(5);
  player.events.get('next turn')({ week: 6, numUsers: 4, waitingForOrders: [], update: next.users[0],
    analytics: next.users.map(({ orderHistory, demandHistory, historyStartWeek }) => ({ orderHistory, demandHistory, historyStartWeek })) });
  assert.match(player.get('#bullwhip').innerHTML, /4\.00× · 中度放大/);
  player.rows.forEach(row => assert.match(row.innerHTML, /4\.00× · 中度放大/));
});
