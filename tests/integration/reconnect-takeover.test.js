/**
 * Tests: player reconnect / takeover & waitingForOrders fixed to 4 roles
 *
 * TC-01: waitingForOrders 固定为4个角色，提交后移除，下周重置
 * TC-02: 断线超时后槽位释放，游戏数据保留
 * TC-03: 新玩家优先顶替断线槽位，不开新组
 * TC-04: 顶替后角色未提交本周 → 可继续提交
 * TC-05: 顶替后角色已提交本周 → 等待下周即可
 * TC-06: 第0周不可操作，4人到齐自动进入第1周
 * TC-07: Socket事件接口验证 (E1-E7)
 * TC-08: player rejoined 事件验证 (E3)
 */

const assert = require('assert');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TEST_PORT || 3211);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-secret';
const RECONNECT_GRACE_MS = 800;
const EXPECTED_ROLES = ['零售商', '批发商', '区域仓库', '工厂'];

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const http = require('http');
    const poll = () => {
      http.get(`${BASE_URL}/`, res => {
        res.resume();
        res.on('end', () => resolve());
      }).on('error', () => {
        if (Date.now() - started > 10000) return reject(new Error('server timeout'));
        setTimeout(poll, 200);
      });
    };
    poll();
  });
}

function connect() {
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

function once(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), ms);
    socket.once(event, (...args) => { clearTimeout(t); resolve(...args); });
  });
}

// Start game and register 4 players. Returns { admin, players, regs, started }
// where started is the array of 'game started' event payloads.
async function setup4Players(prefix) {
  const admin = await connect();
  await emit(admin, 'submit password', ADMIN_PASSWORD);
  await emit(admin, 'start game');

  // Connect all 4 sockets first
  const players = [];
  for (let i = 0; i < 4; i++) {
    players.push(await connect());
  }

  // Register first 3 players
  const regs = [];
  for (let i = 0; i < 3; i++) {
    regs.push(await emit(players[i], 'submit username', `${prefix}-${i + 1}`));
  }

  // Register listeners before 4th player joins (which triggers game started)
  const startedEvents = players.map(s => once(s, 'game started'));

  // 4th player join triggers initGroup → game started
  regs.push(await emit(players[3], 'submit username', `${prefix}-4`));

  const started = await Promise.all(startedEvents);
  return { admin, players, regs, started };
}

// ── TC-01 ──────────────────────────────────────────────────────────────────
async function tc01_waitingForOrdersFixed() {
  const { admin, players, started } = await setup4Players('tc01');
  try {
    // week=1 時 waitingForOrders 固定為4個角色
    started.forEach(msg => {
      assert.deepStrictEqual(msg.waitingForOrders, EXPECTED_ROLES,
        'TC-01: week1 waitingForOrders should be all 4 roles');
    });

    // 零售商提交後移除
    const afterFirst = await emit(players[0], 'submit order', 4);
    assert.deepStrictEqual(afterFirst, ['批发商', '区域仓库', '工厂'],
      'TC-01: after retailer submits, waitingForOrders should have 3 remaining');

    // 其餘3人提交，推進到第2週
    const nextTurnEvents = players.map(s => once(s, 'next turn'));
    await emit(players[1], 'submit order', 4);
    await emit(players[2], 'submit order', 4);
    await emit(players[3], 'submit order', 4);
    const nextTurns = await Promise.all(nextTurnEvents);

    // 第2週 waitingForOrders 重置為4個角色
    nextTurns.forEach(msg => {
      assert.strictEqual(msg.week, 2, 'TC-01: should advance to week 2');
      assert.deepStrictEqual(msg.waitingForOrders, EXPECTED_ROLES,
        'TC-01: week2 waitingForOrders should reset to all 4 roles');
    });

    console.log('  TC-01 PASS: waitingForOrders fixed to 4 roles');
  } finally {
    admin.close();
    players.forEach(s => s && s.close());
  }
}

// ── TC-02 ──────────────────────────────────────────────────────────────────
async function tc02_timeoutSlotReleasedDataPreserved() {
  const { admin, players } = await setup4Players('tc02');
  try {
    // 完成第1週
    const nextTurnEvents = players.map(s => once(s, 'next turn'));
    for (const s of players) await emit(s, 'submit order', 5);
    const turns = await Promise.all(nextTurnEvents);
    const originalCost = turns[0].update.cost;
    const originalInventory = turns[0].update.inventory;

    // 零售商斷線超時
    players[0].close();
    await wait(RECONNECT_GRACE_MS + 300);

    // 新玩家以新用戶名登入，應頂替零售商槽位
    const newPlayer = await connect();
    const reg = await emit(newPlayer, 'submit username', 'tc02-takeover');
    players[0] = newPlayer;

    assert.strictEqual(reg.idx, 0, 'TC-02: should be assigned to retailer slot (index 0)');
    assert.strictEqual(reg.group.users[0].role.name, '零售商',
      'TC-02: takeover slot should be retailer');
    assert.strictEqual(reg.group.users[0].cost, originalCost,
      'TC-02: cost should be inherited');
    assert.strictEqual(reg.group.users[0].inventory, originalInventory,
      'TC-02: inventory should be inherited');

    console.log('  TC-02 PASS: slot released after timeout, data preserved');
  } finally {
    players.forEach(s => s && s.close());
  }
}

// ── TC-03 ──────────────────────────────────────────────────────────────────
async function tc03_newPlayerTakesVacatedSlotNotNewGroup() {
  const { admin, players } = await setup4Players('tc03');
  try {
    // 完成第1週
    const nextTurnEvents = players.map(s => once(s, 'next turn'));
    for (const s of players) await emit(s, 'submit order', 4);
    await Promise.all(nextTurnEvents);

    // 批發商斷線超時
    players[1].close();
    await wait(RECONNECT_GRACE_MS + 300);

    // 新玩家登入
    const newPlayer = await connect();
    const reg = await emit(newPlayer, 'submit username', 'tc03-new');
    players[1] = newPlayer;

    // 應分配到原組（group=0），而非新組
    assert.strictEqual(reg.group.week, 2, 'TC-03: should join existing group at week 2');
    assert.strictEqual(reg.idx, 1, 'TC-03: should take vacated wholesaler slot');
    assert.strictEqual(reg.group.users[1].role.name, '批发商',
      'TC-03: slot role should be wholesaler');

    console.log('  TC-03 PASS: new player takes vacated slot, not a new group');
  } finally {
    players.forEach(s => s && s.close());
  }
}

// ── TC-04 ──────────────────────────────────────────────────────────────────
async function tc04_takeoverCanSubmitIfRoleNotYetSubmitted() {
  const { admin, players } = await setup4Players('tc04');
  try {
    // 完成第1週
    const nextTurnEvents = players.map(s => once(s, 'next turn'));
    for (const s of players) await emit(s, 'submit order', 4);
    await Promise.all(nextTurnEvents);

    // 第2週：零售商還未提交就斷線超時
    players[0].close();
    await wait(RECONNECT_GRACE_MS + 300);

    // 新玩家頂替
    const newPlayer = await connect();
    const reg = await emit(newPlayer, 'submit username', 'tc04-takeover');
    players[0] = newPlayer;

    // 零售商應在 waitingForOrders 中（未提交）
    assert(reg.group.waitingForOrders.includes('零售商'),
      'TC-04: retailer should still be in waitingForOrders after takeover');

    // 頂替玩家可正常提交
    const after = await emit(newPlayer, 'submit order', 6);
    assert(!after.includes('零售商'),
      'TC-04: retailer should be removed from waitingForOrders after submit');

    // 其餘玩家提交，確認能推進第3週
    const nextTurn2Events = players.map(s => once(s, 'next turn'));
    await emit(players[1], 'submit order', 4);
    await emit(players[2], 'submit order', 4);
    await emit(players[3], 'submit order', 4);
    const turns = await Promise.all(nextTurn2Events);
    assert.strictEqual(turns[0].week, 3, 'TC-04: game should advance to week 3');

    console.log('  TC-04 PASS: takeover player can submit when role not yet submitted');
  } finally {
    players.forEach(s => s && s.close());
  }
}

// ── TC-05 ──────────────────────────────────────────────────────────────────
async function tc05_takeoverWaitsNextWeekIfAlreadySubmitted() {
  const { admin, players } = await setup4Players('tc05');
  try {
    // 完成第1週
    const nextTurnEvents = players.map(s => once(s, 'next turn'));
    for (const s of players) await emit(s, 'submit order', 4);
    await Promise.all(nextTurnEvents);

    // 第2週：零售商先提交，再斷線超時
    await emit(players[0], 'submit order', 5);
    players[0].close();
    await wait(RECONNECT_GRACE_MS + 300);

    // 新玩家頂替
    const newPlayer = await connect();
    const reg = await emit(newPlayer, 'submit username', 'tc05-takeover');
    players[0] = newPlayer;

    // 零售商不在 waitingForOrders 中（已提交）
    assert(!reg.group.waitingForOrders.includes('零售商'),
      'TC-05: retailer should NOT be in waitingForOrders (already submitted)');

    // 其餘玩家提交，確認能推進第3週
    // players[0] 是在第2週結束後才頂替進來的，不會收到第2週的 next turn
    const nextTurn2Events = players.slice(1).map(s => once(s, 'next turn'));
    await emit(players[1], 'submit order', 4);
    await emit(players[2], 'submit order', 4);
    await emit(players[3], 'submit order', 4);
    const turns = await Promise.all(nextTurn2Events);
    assert.strictEqual(turns[0].week, 3, 'TC-05: game should advance to week 3 without re-submit');

    console.log('  TC-05 PASS: takeover player waits next week when already submitted');
  } finally {
    players.forEach(s => s && s.close());
  }
}

// ── TC-06 ──────────────────────────────────────────────────────────────────
async function tc06_week0NoOpAutoAdvanceOnFull() {
  const admin = await connect();
  const players = [];
  try {
    // 管理員先登入並啟動遊戲
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    // 前3人登入，week應為0，且不能提交訂單
    for (let i = 0; i < 3; i++) {
      const s = await connect();
      players.push(s);
      const reg = await emit(s, 'submit username', `tc06-${i + 1}`);
      assert.strictEqual(reg.group.week, 0,
        `TC-06: week should be 0 after player ${i + 1} joins`);
      // week=0 時不可提交訂單
      const orderResult = await emit(s, 'submit order', 5);
      assert.ok(orderResult && orderResult.err,
        'TC-06: submit order should be rejected at week 0');
    }

    // 第4人登入，4人到齊自動推進到第1週
    const s4 = await connect();
    players.push(s4);

    const startedEvents = players.map(s => once(s, 'game started'));
    await emit(s4, 'submit username', 'tc06-4');
    const startedMsgs = await Promise.all(startedEvents);

    startedMsgs.forEach(msg => {
      assert.strictEqual(msg.week, 1, 'TC-06: should auto-advance to week 1');
      assert.deepStrictEqual(msg.waitingForOrders, EXPECTED_ROLES,
        'TC-06: waitingForOrders should be all 4 roles');
    });

    console.log('  TC-06 PASS: admin starts game first, 4th player triggers week 1');
  } finally {
    admin.close();
    players.forEach(s => s && s.close());
  }
}

// ── TC-07 ──────────────────────────────────────────────────────────────────
async function tc07_eventInterfacesNormalFlow() {
  const admin = await connect();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    // Listen for update table BEFORE players register (multiple events expected)
    const updateTableEvents = [];
    admin.on('update table', (data) => updateTableEvents.push(data));

    // --- E1: group member joined ---
    players.push(await connect());
    await emit(players[0], 'submit username', 'tc07-1');

    // Player 2 joins - player 1 should get group member joined
    const memberJoinedPromise = once(players[0], 'group member joined');
    players.push(await connect());
    await emit(players[1], 'submit username', 'tc07-2');
    const memberJoined = await memberJoinedPromise;

    assert.strictEqual(memberJoined.idx, 1, 'E1: joined idx should be 1');
    assert.strictEqual(memberJoined.update.role.name, '批发商',
      'E1: joined role should be wholesaler');
    assert.strictEqual(memberJoined.update.name, 'tc07-2',
      'E1: joined player name should be correct');

    // Player 3 joins
    const joined3Promise = once(players[0], 'group member joined');
    players.push(await connect());
    await emit(players[2], 'submit username', 'tc07-3');
    const joined3 = await joined3Promise;
    assert.strictEqual(joined3.idx, 2, 'E1: 3rd player idx should be 2');
    assert.strictEqual(joined3.update.role.name, '区域仓库',
      'E1: 3rd player role should be warehouse');

    // Player 4 joins → triggers game started
    const joined4Promise = once(players[0], 'group member joined');
    players.push(await connect());
    const startedEvents = players.map(s => once(s, 'game started'));
    await emit(players[3], 'submit username', 'tc07-4');
    const joined4 = await joined4Promise;
    assert.strictEqual(joined4.idx, 3, 'E1: 4th player idx should be 3');
    assert.strictEqual(joined4.update.role.name, '工厂',
      'E1: 4th player role should be factory');

    await Promise.all(startedEvents);

    // --- E5: admin update table ---
    await wait(100); // let any pending events arrive
    const lastTable = updateTableEvents[updateTableEvents.length - 1];
    assert.ok(lastTable, 'E5: admin should have received update table');
    assert.strictEqual(lastTable.numUsers, 4, 'E5: numUsers should be 4');
    assert.strictEqual(lastTable.groups.length, 1, 'E5: should have 1 group');
    assert.strictEqual(lastTable.groups[0].users.length, 4,
      'E5: group should have 4 users');

    // --- E2: update order wait ---
    // Player 2 listens, player 1 submits order
    const orderWaitPromise = once(players[1], 'update order wait');
    const afterFirst = await emit(players[0], 'submit order', 4);
    assert.deepStrictEqual(afterFirst, ['批发商', '区域仓库', '工厂'],
      'E2: callback waitingForOrders after first submit');
    const orderWait = await orderWaitPromise;
    assert.deepStrictEqual(orderWait, ['批发商', '区域仓库', '工厂'],
      'E2: broadcast waitingForOrders should match');

    // --- E6: admin update group ---
    const updateGroupPromise = once(admin, 'update group');
    const nextTurnEvents = players.map(s => once(s, 'next turn'));
    await emit(players[1], 'submit order', 4);
    await emit(players[2], 'submit order', 4);
    await emit(players[3], 'submit order', 4);
    const updateGroup = await updateGroupPromise;
    await Promise.all(nextTurnEvents);

    assert.strictEqual(updateGroup.groupNum, 0, 'E6: groupNum should be 0');
    assert.strictEqual(updateGroup.groupData.week, 2, 'E6: week should be 2');
    assert.ok(updateGroup.groupData.cost !== undefined, 'E6: should have cost');

    // --- E7: game ended ---
    const gameEndedEvents = players.map(s => once(s, 'game ended'));
    await emit(admin, 'end game');
    const endedMsgs = await Promise.all(gameEndedEvents);

    endedMsgs.forEach((msg, i) => {
      assert.strictEqual(msg.numUsers, 4,
        `E7: player ${i + 1} game ended numUsers should be 4`);
    });

    console.log('  TC-07 PASS: E1 member joined, E2 order wait, E5 update table, E6 update group, E7 game ended');
  } finally {
    admin.close();
    players.forEach(s => s && s.close());
  }
}

// ── TC-08 ──────────────────────────────────────────────────────────────────
async function tc08_playerRejoinedEvent() {
  const admin = await connect();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connect());
    }
    const startedEvents = players.map(s => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `tc08-${i + 1}`);
    }
    await Promise.all(startedEvents);

    // Player 2 (index 1) disconnects and reconnects within grace period
    // Player 1 listens for the 'player rejoined' event
    const rejoinedPromise = once(players[0], 'player rejoined');
    players[1].close();
    await wait(150);

    // Reconnect with same username
    const reconnected = await connect();
    const reg = await emit(reconnected, 'submit username', 'tc08-2');
    players[1] = reconnected;

    // Verify reconnect data
    assert.strictEqual(reg.reconnected, true, 'E3: should be reconnected');
    assert.strictEqual(reg.idx, 1, 'E3: should restore index 1');

    // Verify other player received player rejoined event
    const rejoined = await rejoinedPromise;
    assert.strictEqual(rejoined.idx, 1, 'E3: rejoined idx should be 1');
    assert.strictEqual(rejoined.update.name, 'tc08-2',
      'E3: rejoined player name should be correct');
    assert.strictEqual(rejoined.update.role.name, '批发商',
      'E3: rejoined role should be wholesaler');

    console.log('  TC-08 PASS: E3 player rejoined event');
  } finally {
    admin.close();
    players.forEach(s => s && s.close());
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────
async function runIsolated(name, testFn) {
  const server = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD,
      MOBILE_RECONNECT_GRACE_MS: String(RECONNECT_GRACE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  server.stdout.on('data', c => { output += c.toString(); });
  server.stderr.on('data', c => { output += c.toString(); });

  try {
    await waitForServer();
    console.log(`  running ${name}...`);
    await testFn();
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(output);
    throw err;
  } finally {
    server.kill();
    await wait(400);
  }
}

async function main() {
  console.log('reconnect-takeover tests');
  await runIsolated('TC-01', tc01_waitingForOrdersFixed);
  await runIsolated('TC-02', tc02_timeoutSlotReleasedDataPreserved);
  await runIsolated('TC-03', tc03_newPlayerTakesVacatedSlotNotNewGroup);
  await runIsolated('TC-04', tc04_takeoverCanSubmitIfRoleNotYetSubmitted);
  await runIsolated('TC-05', tc05_takeoverWaitsNextWeekIfAlreadySubmitted);
  await runIsolated('TC-06', tc06_week0NoOpAutoAdvanceOnFull);
  await runIsolated('TC-07', tc07_eventInterfacesNormalFlow);
  await runIsolated('TC-08', tc08_playerRejoinedEvent);
  console.log('all reconnect-takeover tests passed');
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
