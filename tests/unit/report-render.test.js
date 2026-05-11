const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../public/report.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

function createContext(gameGroup) {
  const elements = {};
  const document = {
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = { textContent: '', innerHTML: '' };
      }
      return elements[id];
    },
  };

  const localStorage = {
    getItem(key) {
      return key === 'beerGameGroup' ? JSON.stringify(gameGroup) : null;
    },
  };

  const context = {
    console,
    document,
    localStorage,
    window: {
      gameGroup,
      addEventListener() {},
      onload: null,
      print() {},
    },
    setTimeout() {},
    Date,
    Math,
    JSON,
    Number,
    Array,
    isNaN,
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  return { context, elements };
}

function makeRole(name, downstreamName) {
  return {
    name,
    downstream: { name: downstreamName },
    upstream: {},
  };
}

const groupWithZeroCost = [{
  week: 1,
  cost: 0,
  users: [
    { name: 'A', role: makeRole('零售商', '客户'), cost: 0, inventory: 12, backlog: 0, orderHistory: [] },
    { name: 'B', role: makeRole('批发商', '零售商'), cost: 0, inventory: 12, backlog: 0, orderHistory: [] },
    { name: 'C', role: makeRole('区域仓库', '批发商'), cost: 0, inventory: 12, backlog: 0, orderHistory: [] },
    { name: 'D', role: makeRole('工厂', '区域仓库'), cost: 0, inventory: 12, backlog: 0, orderHistory: [] },
  ],
}];

const { context, elements } = createContext(groupWithZeroCost);
context.generateReport();

assert.strictEqual(elements.totalPlayers.textContent, '4 人');
assert.strictEqual(elements.bestCost.textContent, '¥0');
assert.strictEqual(elements.avgCost.textContent, '¥0');
assert.strictEqual(elements.worstCost.textContent, '¥0');
assert.match(elements.groupsContainer.innerHTML, /团队 #1/);
assert.match(elements.groupsContainer.innerHTML, /零售商/);
assert.doesNotMatch(elements.insightText.textContent, /NaN|Infinity/);

const groupWithFullOrderHistory = [{
  week: 27,
  cost: 100,
  users: [
    { name: 'A', role: makeRole('零售商', '客户'), cost: 10, inventory: 1, backlog: 0, orderHistory: Array.from({ length: 26 }, (_, i) => i + 1) },
    { name: 'B', role: makeRole('批发商', '零售商'), cost: 20, inventory: 2, backlog: 0, orderHistory: Array.from({ length: 26 }, (_, i) => i + 2) },
    { name: 'C', role: makeRole('区域仓库', '批发商'), cost: 30, inventory: 3, backlog: 0, orderHistory: Array.from({ length: 26 }, (_, i) => i + 3) },
    { name: 'D', role: makeRole('工厂', '区域仓库'), cost: 40, inventory: 4, backlog: 0, orderHistory: Array.from({ length: 26 }, (_, i) => i + 4) },
  ],
}];

const full = createContext(groupWithFullOrderHistory);
full.context.generateReport();
const orderBars = full.elements.groupsContainer.innerHTML.match(/class="mini-bar week/g) || [];
const costBars = full.elements.groupsContainer.innerHTML.match(/class="mini-bar cost-bar/g) || [];
assert.strictEqual(orderBars.length, 26);
assert.strictEqual(costBars.length, 1);
assert.match(full.elements.groupsContainer.innerHTML, /W26: 110/);
assert.doesNotMatch(full.elements.groupsContainer.innerHTML, /W27:/);
assert.match(full.elements.groupsContainer.innerHTML, /团队每周下单总量/);
assert.match(full.elements.groupsContainer.innerHTML, /累计总成本趋势/);

console.log('report render test passed');
