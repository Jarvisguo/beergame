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

console.log('report render test passed');
