const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const textUpdates = {};
const appended = {};
const handlers = {};
const api = {
  hide() { return this; },
  show() { return this; },
  empty() { return this; },
  append(value) {
    if (value !== undefined) {
      if (!appended[this.selector]) appended[this.selector] = [];
      appended[this.selector].push(value);
    }
    return this;
  },
  change() { return this; },
  click() { return this; },
  on() { return this; },
  modal() { return this; },
  val() { return '0'; },
  attr() { return this; },
  addClass() { return this; },
  removeClass() { return this; },
  text(value) {
    if (value !== undefined) textUpdates[this.selector] = value;
    return this;
  },
  html(value) {
    if (value !== undefined) textUpdates[this.selector] = value;
    return this;
  }
};

const context = {
  console,
  window: {},
  document: {
    getElementById() {
      return {};
    }
  },
  sessionStorage: { setItem() {} },
  google: {
    charts: { load() {} },
    visualization: {
      LineChart: function LineChart() {
        return { draw() {} };
      },
      DataTable: function DataTable() {
        return {
          rows: [],
          addColumn() {},
          addRows(rows) {
            this.rows = this.rows.concat(rows);
            context.__lastDataTable = this;
          }
        };
      }
    }
  },
  io() {
    return {
      on(event, handler) {
        handlers[event] = handler;
      },
      emit() {}
    };
  },
  $(selectorOrHandler) {
    if (typeof selectorOrHandler === 'function') return;
    if (selectorOrHandler === context.document) return { ready() {} };
    return Object.assign({ selector: selectorOrHandler }, api);
  }
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('public/admin.js', 'utf8'), context);

const groups = [{
  week: 3,
  cost: 18,
  waitingForOrders: ['批发商', '工厂'],
  users: [
    { name: 'a', socketId: '1', inventory: 10, backlog: 1, role: { name: '零售商' }, costHistory: [0, 6], inventoryHistory: [12, 10], backlogHistory: [0, 1], orderHistory: [4, 8] },
    { name: 'b', socketId: '2', inventory: 11, backlog: 2, role: { name: '批发商' }, costHistory: [0, 5], inventoryHistory: [12, 11], backlogHistory: [0, 2], orderHistory: [4, 6] },
    { name: 'c', socketId: '3', inventory: 12, backlog: 3, role: { name: '区域仓库' }, costHistory: [0, 4], inventoryHistory: [12, 12], backlogHistory: [0, 3], orderHistory: [4, 5] },
    { name: 'd', socketId: '4', inventory: 13, backlog: 4, role: { name: '工厂' }, costHistory: [0, 3], inventoryHistory: [12, 13], backlogHistory: [0, 4], orderHistory: [4, 4] }
  ],
  costHistory: [0, 18]
}];

context.gameGroup = groups;
context.startGame(4);
assert.strictEqual(textUpdates['#status'], '游戏已开始。当前有 4 名参与者。');
assert(appended['#group0'].includes('<td>46</td>'), 'admin table should show total inventory');
assert(appended['#group0'].includes('<td>10</td>'), 'admin table should show total backlog');
assert(appended['#group0'].includes('<td>批发商、工厂</td>'), 'admin table should show waiting roles');

handlers['update table']({ numUsers: 3, groups });
assert.strictEqual(textUpdates['#status'], '游戏已开始。当前有 3 名参与者。');

context.drawChart(0, 'Orders');
assert.strictEqual(JSON.stringify(context.__lastDataTable.rows), JSON.stringify([
  ['1', 4, 4, 4, 4],
  ['2', 8, 6, 5, 4]
]));

appended['#grouptable > tbody'] = [];
groups[0].week = 27;
context.refreshTable(groups, 4, true);
assert(appended['#grouptable > tbody'].some((row) => row.includes('已完成 26 轮') && !row.includes('当前第 27 周')), 'admin table should cap completed games at 26 weeks');

console.log('admin status test passed');
