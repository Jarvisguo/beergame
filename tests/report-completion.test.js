const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createContext, runInContext } = require('node:vm');
const test = require('node:test');

const html = readFileSync('public/report.html', 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .find(m => m[1].includes('function generateReport()'))[1];
function report(groups) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], { textContent: '', innerHTML: '', hidden: false }]));
  let stored = JSON.stringify(groups);
  const events = new Map();
  const context = createContext({ document: { getElementById: id => elements.get(id) },
    window: { addEventListener: (e, h) => events.set(e, h) },
    localStorage: { getItem: () => stored }, setTimeout() {}, console });
  runInContext(script, context);
  const render = () => runInContext('generateReport()', context);
  render();
  return { get: id => elements.get(id), render, context,
    update(next) { stored = JSON.stringify(next); events.get('storage')({ key: 'beerGameGroup', newValue: stored }); },
    clear() { stored = null; events.get('storage')({ key: 'beerGameGroup', newValue: null }); },
    text: () => [...elements.values()].map(e => e.textContent + e.innerHTML).join('\n') };
}
function group(week, cost, name, orders = Array(26).fill(4)) {
  return { week, cost, costHistory: [cost], users: [{ name, cost, inventory: 12, backlog: 0,
    role: { name: '零售商', downstream: { name: '客户' } }, orderHistory: orders,
    inventoryHistory: [12], backlogHistory: [0], costHistory: [cost] }] };
}

test('only completed teams contribute to every report section, retaining original team numbers', () => {
  const p = report([group(26, 1, 'unfinished-last-week', [100, 0, 100]), group(27, 300, 'finished-two'),
    group(5, 99999, 'unfinished-expensive'), group(27, 100, 'finished-four')]);
  assert.equal(p.get('totalGroups').textContent, '团队数量：2 组');
  assert.equal(p.get('totalPlayers').textContent, '2 人');
  assert.equal(p.get('groupIds').textContent, '团队编号：#2, #4');
  assert.equal(p.get('bestTeam').textContent, '团队 #4');
  assert.equal(p.get('bestCost').textContent, '¥100');
  assert.equal(p.get('avgCost').textContent, '¥200');
  assert.equal(p.get('worstCost').textContent, '¥300');
  assert.equal(p.get('avgBullwhip').textContent, '0%');
  assert.equal(p.get('severeBullwhip').textContent, '0 / 2');
  assert.equal(p.get('maxBullwhipScore').textContent, '0%');
  assert.equal(p.get('weekSummary').textContent, '#2: 已完成 26 轮；#4: 已完成 26 轮');
  assert.match(p.get('groupsContainer').innerHTML, /团队 #4 — 第 1 名/);
  assert.match(p.get('groupsContainer').innerHTML, /团队 #2 — 第 2 名/);
  assert.doesNotMatch(p.text(), /unfinished|99999|团队 #1|团队 #3/);
});

test('week 26 is unfinished; a zero-cost team that completes week 26 is included', () => {
  const p = report([group(26, 500, 'still-ordering')]);
  assert.match(p.get('groupsContainer').innerHTML, /暂无完成全部 26 周的小组/);
  assert.equal(p.get('bestTeam').textContent, '—');
  p.update([group(27, 0, 'completed-zero-cost')]);
  assert.equal(p.get('totalGroups').textContent, '团队数量：1 组');
  assert.equal(p.get('bestTeam').textContent, '团队 #1');
  assert.equal(p.get('bestCost').textContent, '¥0');
  assert.match(p.get('groupsContainer').innerHTML, /completed-zero-cost/);
});

test('reset, removal and empty data clear old rankings, metrics, cards and insights', () => {
  for (const next of [[], [group(26, 1, 'incomplete')], null]) {
    const p = report([group(27, 12345, 'old-champion')]);
    if (next === null) p.clear(); else p.update(next);
    assert.equal(p.get('totalGroups').textContent, '团队数量：0 组');
    assert.equal(p.get('totalPlayers').textContent, '0 人');
    for (const id of ['bestTeam', 'bestCost', 'avgCost', 'worstCost', 'avgBullwhip', 'severeBullwhip', 'maxBullwhipScore']) {
      assert.equal(p.get(id).textContent, '—', id);
    }
    assert.equal(p.get('keyInsight').hidden, true);
    assert.doesNotMatch(p.text(), /old-champion|12345/);
    assert.match(p.get('groupsContainer').innerHTML, /暂无完成全部 26 周的小组/);
  }
});

test('ending the game keeps server group numbers through the admin cache and final report', () => {
  const groups = [group(27, 300, 'original-one'), group(5, 1, 'original-two-unfinished'), group(27, 100, 'original-three')];
  groups.forEach(g => { g.costHistory = Array(26).fill(g.cost); });
  const elements = new Map(), storage = new Map();
  function element() {
    return { innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, children: [],
      addEventListener() {}, appendChild(child) { this.children.push(child); } };
  }
  function get(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); }
  const admin = createContext({ document: { querySelector: get, createElement: element }, window: {},
    localStorage: { setItem: (k, v) => storage.set(k, v) }, io: () => ({ on() {}, emit() {} }),
    setTimeout() {}, clearTimeout() {}, console, groups });
  runInContext(readFileSync('public/admin.js', 'utf8'), admin);
  runInContext('gameGroup = groups; rankGroups()', admin);
  const cached = JSON.parse(storage.get('beerGameGroup'));
  assert.deepEqual(cached.map(g => g.users[0].name), ['original-one', 'original-two-unfinished', 'original-three']);
  const p = report(cached);
  assert.equal(p.get('groupIds').textContent, '团队编号：#1, #3');
  assert.equal(p.get('bestTeam').textContent, '团队 #3');
  assert.match(p.get('groupsContainer').innerHTML, /团队 #1 — 第 2 名/);
  assert.doesNotMatch(p.text(), /original-two-unfinished/);
  const rankingRows = get('#adminTbody').children.map(row => row.innerHTML);
  assert.match(rankingRows[0], /1（团队 #2）/, 'admin ranking remains sorted without changing identity');
  assert.match(rankingRows[1], /2（团队 #3）/);
});
