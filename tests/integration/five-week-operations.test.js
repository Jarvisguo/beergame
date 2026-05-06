const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TEST_PORT || 3220);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-secret';
const ROLE_NAMES = ['零售商', '批发商', '区域仓库', '工厂'];
const PLAYER_NAMES = ['retailer', 'wholesaler', 'warehouse', 'factory'];
const ORDERS = [
  [4, 4, 4, 4],
  [8, 6, 5, 4],
  [2, 10, 7, 6],
  [6, 3, 12, 8],
  [5, 9, 4, 10]
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${path}`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`timeout loading ${path}`)));
  });
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      if ((await request('/')) === 200) return;
    } catch (err) {
      // Server is still booting.
    }
    await wait(200);
  }
  throw new Error('server did not start in time');
}

function connectClient() {
  const socket = io(BASE_URL, { timeout: 5000, reconnection: false });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emit(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, ...args, (err, payload) => {
      if (err) reject(err);
      else resolve(payload);
    });
  });
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function createRole(index) {
  const upstreamNames = ['批发商', '区域仓库', '工厂', '工厂'];
  const downstreamNames = ['客户', '零售商', '批发商', '区域仓库'];
  return {
    name: ROLE_NAMES[index],
    upstream: { name: upstreamNames[index], orders: 4, shipments: 4 },
    downstream: { name: downstreamNames[index], orders: 4, shipments: 4 }
  };
}

function simulateExpected() {
  const users = ROLE_NAMES.map((role, index) => ({
    name: PLAYER_NAMES[index],
    role: createRole(index),
    cost: 0,
    inventory: 12,
    backlog: 0,
    inventoryHistory: [],
    backlogHistory: [],
    costHistory: [],
    orderHistory: []
  }));
  const group = {
    week: 1,
    cost: 0,
    costHistory: [],
    users,
    shipping: [[4, 4], [4, 4], [4, 4], [4, 4]],
    mailing: [[4], [4], [4]]
  };
  const weekly = [];

  for (let week = 0; week < ORDERS.length; week++) {
    for (let i = 0; i < users.length; i++) {
      users[i].role.upstream.orders = ORDERS[week][i];
    }

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      user.costHistory.push(user.cost);
      user.inventoryHistory.push(user.inventory);
      user.backlogHistory.push(user.backlog);

      user.role.upstream.shipments = group.shipping[i].shift();
      user.inventory += user.role.upstream.shipments;

      if (i === 0) {
        user.role.downstream.orders = 4;
      } else {
        user.role.downstream.orders = group.mailing[i - 1].shift();
      }

      const toShip = user.backlog + user.role.downstream.orders;
      user.role.downstream.shipments = toShip > user.inventory ? user.inventory : toShip;

      if (i !== 0) {
        group.shipping[i - 1].push(user.role.downstream.shipments);
      }

      user.backlog = toShip > user.inventory ? toShip - user.inventory : 0;
      user.inventory = toShip > user.inventory ? 0 : user.inventory - toShip;

      if (i === 3) {
        group.shipping[i].push(user.role.upstream.orders);
      } else {
        group.mailing[i].push(user.role.upstream.orders);
      }

      user.orderHistory.push(user.role.upstream.orders);
      group.cost += user.cost;
      user.cost += user.inventory * 0.5 + user.backlog;
    }

    group.costHistory.push(group.cost);
    group.week++;
    weekly.push(users.map((user) => JSON.parse(JSON.stringify(user))));
  }

  return { weekly, group };
}

function assertUserState(actual, expected, label) {
  assert.strictEqual(actual.role.name, expected.role.name, `${label} role`);
  assert.strictEqual(actual.role.downstream.name, expected.role.downstream.name, `${label} downstream role`);
  assert.strictEqual(actual.role.upstream.name, expected.role.upstream.name, `${label} upstream role`);
  assert.strictEqual(actual.role.downstream.orders, expected.role.downstream.orders, `${label} downstream orders`);
  assert.strictEqual(actual.role.downstream.shipments, expected.role.downstream.shipments, `${label} downstream shipments`);
  assert.strictEqual(actual.role.upstream.shipments, expected.role.upstream.shipments, `${label} upstream shipments`);
  assert.strictEqual(actual.inventory, expected.inventory, `${label} inventory`);
  assert.strictEqual(actual.backlog, expected.backlog, `${label} backlog`);
  assert.strictEqual(actual.cost, expected.cost, `${label} cost`);
  assert.deepStrictEqual(actual.orderHistory, expected.orderHistory, `${label} order history`);
  assert.deepStrictEqual(actual.inventoryHistory, expected.inventoryHistory, `${label} inventory history`);
  assert.deepStrictEqual(actual.backlogHistory, expected.backlogHistory, `${label} backlog history`);
  assert.deepStrictEqual(actual.costHistory, expected.costHistory, `${label} cost history`);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length);
}

function reportMetricsFor(user) {
  return {
    finalCost: user.cost,
    finalInventory: user.inventory,
    finalBacklog: user.backlogHistory[user.backlogHistory.length - 1],
    mean: mean(user.orderHistory),
    stdDev: stdDev(user.orderHistory)
  };
}

async function main() {
  const expected = simulateExpected();
  const server = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD,
      MOBILE_RECONNECT_GRACE_MS: '700'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const players = [];
  let admin;
  try {
    await waitForServer();
    admin = await connectClient();
    await emit(admin, 'submit password', ADMIN_PASSWORD);

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
      const registration = await emit(players[i], 'submit username', PLAYER_NAMES[i]);
      assert.strictEqual(registration.idx, i);
      assert.strictEqual(registration.group.users[i].role.name, ROLE_NAMES[i]);
    }

    const startedEvents = players.map((socket) => once(socket, 'game started'));
    await emit(admin, 'start game');
    await Promise.all(startedEvents);

    let lastTurns = [];
    for (let week = 0; week < ORDERS.length; week++) {
      const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
      for (let role = 0; role < players.length; role++) {
        await emit(players[role], 'submit order', ORDERS[week][role]);
      }
      lastTurns = await Promise.all(nextTurnEvents);
      assert.deepStrictEqual(lastTurns.map((msg) => msg.week), [week + 2, week + 2, week + 2, week + 2]);

      for (let role = 0; role < lastTurns.length; role++) {
        assertUserState(lastTurns[role].update, expected.weekly[week][role], `week ${week + 1} ${ROLE_NAMES[role]}`);
      }
    }

    const ended = await emit(admin, 'end game');
    const actualGroup = ended.groups[0];
    assert.strictEqual(actualGroup.week, expected.group.week);
    assert.strictEqual(actualGroup.cost, expected.group.cost);
    assert.deepStrictEqual(actualGroup.costHistory, expected.group.costHistory);

    for (let role = 0; role < actualGroup.users.length; role++) {
      assertUserState(actualGroup.users[role], expected.group.users[role], `final ${ROLE_NAMES[role]}`);
    }

    const totalPlayers = actualGroup.users.length;
    const allCosts = [actualGroup.cost];
    assert.strictEqual(totalPlayers, 4, 'report total players');
    assert.strictEqual(`游戏周期：${actualGroup.week} 周`, '游戏周期：6 周');
    assert.strictEqual(`团队数量：${1} 组`, '团队数量：1 组');
    assert.strictEqual(`¥${Math.round(Math.min(...allCosts))}`, `¥${Math.round(expected.group.cost)}`);
    assert.strictEqual(`¥${Math.round(mean(allCosts))}`, `¥${Math.round(expected.group.cost)}`);
    assert.strictEqual(`¥${Math.round(Math.max(...allCosts))}`, `¥${Math.round(expected.group.cost)}`);

    for (let role = 0; role < actualGroup.users.length; role++) {
      const actualReport = reportMetricsFor(actualGroup.users[role]);
      const expectedReport = reportMetricsFor(expected.group.users[role]);
      assert.deepStrictEqual(actualReport, expectedReport, `report metrics ${ROLE_NAMES[role]}`);
    }
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    players.forEach((socket) => socket && socket.close());
    if (admin) admin.close();
    server.kill();
  }
}

main()
  .then(() => {
    console.log('five-week operations test passed');
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
