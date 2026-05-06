const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const updates = {};
const selectorApi = {
  text(value) {
    if (value !== undefined) updates[this.selector] = value;
    return this;
  },
  hide() { return this; },
  show() { return this; },
  fadeIn() { return this; },
  fadeOut() { return this; },
  modal() { return this; },
  attr() { return this; },
  val() { return this; },
  html(value) {
    if (value !== undefined) updates[this.selector] = value;
    return this;
  },
  css() { return this; },
  parent() { return this; },
  find() { return { length: 0 }; },
  append() { return this; },
  on() { return this; },
  click() { return this; },
  each() { return this; },
  addClass() { return this; },
  removeClass() { return this; }
};

const handlers = {};
const context = {
  console,
  window: {},
  document: {},
  CountUp: function CountUp() {},
  io() {
    return {
      on(event, handler) {
        handlers[event] = handler;
      },
      emit() {}
    };
  },
  $(selectorOrHandler) {
    if (typeof selectorOrHandler === 'function') {
      return;
    }
    if (selectorOrHandler === context.document) {
      return {
        ready() {}
      };
    }
    return Object.assign({ selector: selectorOrHandler }, selectorApi);
  }
};

context.CountUp.prototype.start = function start(callback) {
  if (callback) callback();
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('public/client.js', 'utf8'), context);

handlers['game started']({
  numUsers: 4,
  week: 1,
  waitingForOrders: ['零售商', '批发商', '区域仓库', '工厂']
});

assert.strictEqual(updates['#userRole'], undefined, 'board should not update before a user is set');

vm.runInContext(`
  curUser = {
    name: 'test4',
    cost: 0,
    inventory: 12,
    backlog: 0,
    role: {
      name: '工厂',
      upstream: { name: '工厂', orders: 4, shipments: 4 },
      downstream: { name: '区域仓库', orders: 4, shipments: 4 }
    }
  };
  curGroup = { waitingForOrders: ['零售商', '批发商', '区域仓库', '工厂'] };
`, context);

handlers['game started']({
  numUsers: 4,
  week: 1,
  waitingForOrders: ['零售商', '批发商', '区域仓库', '工厂']
});

assert.strictEqual(updates['#userRole'], '工厂（您）');
assert.strictEqual(updates['#downstreamRole'], '区域仓库');
assert.strictEqual(updates['#upstreamRole'], '工厂');
assert.strictEqual(updates['#inventoryAmt'], 12);

console.log('client board test passed');
