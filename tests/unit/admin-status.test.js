const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const textUpdates = {};
const handlers = {};
const api = {
  hide() { return this; },
  show() { return this; },
  empty() { return this; },
  append() { return this; },
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
          addColumn() {},
          addRows() {}
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
  week: 1,
  cost: 0,
  users: [
    { name: 'a', socketId: '1', role: { name: '零售商' } },
    { name: 'b', socketId: '2', role: { name: '批发商' } },
    { name: 'c', socketId: '3', role: { name: '区域仓库' } },
    { name: 'd', socketId: '4', role: { name: '工厂' } }
  ],
  costHistory: [0]
}];

context.gameGroup = groups;
context.startGame(4);
assert.strictEqual(textUpdates['#status'], '游戏已开始。当前有 4 名参与者。');

handlers['update table']({ numUsers: 3, groups });
assert.strictEqual(textUpdates['#status'], '游戏已开始。当前有 3 名参与者。');

console.log('admin status test passed');
