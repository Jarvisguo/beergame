const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TEST_PORT || 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-secret';
const RECONNECT_GRACE_MS = 700;
const EXPECTED_ROLES = ['零售商', '批发商', '区域仓库', '工厂'];

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
  const socket = io(BASE_URL, {
    timeout: 5000,
    reconnection: false
  });

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
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for '${event}'`));
    }, ms);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, handler);
  });
}

// TC3: 静态资源可访问
async function assertStaticAssets() {
  for (const path of ['/', '/admin.html', '/report.html', '/socket.io/socket.io.js']) {
    assert.strictEqual(await request(path), 200, `${path} should load`);
  }
}

// A1, A2: 管理员认证
async function assertAdminAuth() {
  const admin = await connectClient();
  try {
    assert.strictEqual(await emit(admin, 'submit password', 'wrong'), 'Invalid Password');
    const ok = await emit(admin, 'submit password', ADMIN_PASSWORD);
    assert.strictEqual(ok.status, 'waiting');
    assert.strictEqual(ok.numUsers, 0);
  } finally {
    admin.close();
  }
}

// P1: waiting 状态下不允许玩家登录
async function assertLoginBlockedWhenWaiting() {
  const player = await connectClient();
  try {
    const result = await emit(player, 'submit username', 'early-bird');
    assert.ok(
      typeof result === 'string' || (result && result.err),
      'login should be rejected when game is in waiting state'
    );
  } finally {
    player.close();
  }
}

// P2, P3, P4, P5, G1, G2, A4: 完整游戏流程
async function runFullGameFlow() {
  const admin = await connectClient();
  const players = [];
  try {
    // A4: 先开始游戏，再让玩家登录
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }

    // P2, P3: 4 人依次登录，第 4 人触发 game started
    const registrations = [];
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < players.length; i++) {
      registrations.push(await emit(players[i], 'submit username', `player-${i + 1}`));
    }

    const roles = registrations.map((msg) => msg.group.users[msg.idx].role.name);
    assert.deepStrictEqual(roles, EXPECTED_ROLES);

    const started = await Promise.all(gameStartedEvents);
    started.forEach((msg) => {
      assert.strictEqual(msg.week, 1);
      assert.deepStrictEqual(msg.waitingForOrders, EXPECTED_ROLES);
    });

    // P4: 同用户名重复登录被拒绝
    const duplicate = await connectClient();
    try {
      const dupResult = await emit(duplicate, 'submit username', 'player-1');
      assert.ok(
        typeof dupResult === 'string' || (dupResult && dupResult.err),
        'duplicate username should be rejected'
      );
    } finally {
      duplicate.close();
    }

    // G2: 部分提交时广播 update order wait
    const firstWaitingList = await emit(players[0], 'submit order', 4);
    assert.deepStrictEqual(firstWaitingList, ['批发商', '区域仓库', '工厂']);

    // G1: 所有人提交后推进到下一周
    const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
    await emit(players[1], 'submit order', 5);
    await emit(players[2], 'submit order', 6);
    await emit(players[3], 'submit order', 7);
    const nextTurns = await Promise.all(nextTurnEvents);
    const nextRoles = nextTurns.map((msg) => msg.update.role.name);
    assert.deepStrictEqual(nextRoles, EXPECTED_ROLES);
    nextTurns.forEach((msg) => {
      assert.strictEqual(msg.week, 2);
      assert.deepStrictEqual(msg.waitingForOrders, EXPECTED_ROLES);
    });

    // P5: 第 5 人登录创建新组
    const fifth = await connectClient();
    players.push(fifth);
    const fifthResult = await emit(fifth, 'submit username', 'player-5');
    assert.strictEqual(fifthResult.idx, 0, 'fifth player should be in a new group at slot 0');
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// R1, R2: 宽限期内重连与不同用户名分配
async function assertDifferentUsernameCannotTakeGraceSeat() {
  const admin = await connectClient();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `reserved-${i + 1}`);
    }
    await Promise.all(gameStartedEvents);

    // R2: player-3 断线（宽限期内），新用户不能顶替，应分配到新组
    players[2].close();
    await wait(100);

    const replacement = await connectClient();
    players.push(replacement);
    const replacementJoin = await emit(replacement, 'submit username', 'reserved-replacement');
    assert.strictEqual(replacementJoin.idx, 0, 'different username should start a new group at slot 0');
    assert.strictEqual(replacementJoin.group.users[0].role.name, '零售商');

    // R1: 原用户重连恢复原 slot
    const reconnect = await connectClient();
    players.push(reconnect);
    const rejoined = await emit(reconnect, 'submit username', 'reserved-3');
    assert.strictEqual(rejoined.idx, 2);
    assert.strictEqual(rejoined.group.users[2].role.name, '区域仓库');
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// R3: 宽限期结束后槽位释放
async function assertDisconnectExpiresAfterGrace() {
  const admin = await connectClient();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `expire-${i + 1}`);
    }
    await Promise.all(gameStartedEvents);

    players[1].close();
    await wait(RECONNECT_GRACE_MS + 250);

    const afterExpiry = await emit(admin, 'submit password', ADMIN_PASSWORD);
    assert.strictEqual(afterExpiry.numUsers, 3, 'expired disconnect should reduce online count');
    assert.strictEqual(afterExpiry.groups[0].users[1].socketId, undefined);
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// 服务器健壮性：无 ack 回调不崩溃
async function assertNoAckCrash() {
  const admin = await connectClient();
  try {
    admin.emit('submit password', ADMIN_PASSWORD);
    admin.emit('start game');
    await wait(300);
    assert.strictEqual(await request('/'), 200, 'server should stay alive without ack callbacks');
  } finally {
    admin.close();
  }
}

// G5, G6: 26 周后不可提交订单
async function assertWeekLimitStopsOrdersAt26() {
  const admin = await connectClient();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `limit-${i + 1}`);
    }
    await Promise.all(gameStartedEvents);

    for (let round = 1; round <= 26; round++) {
      const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
      for (let i = 0; i < players.length; i++) {
        await emit(players[i], 'submit order', 4);
      }
      const turns = await Promise.all(nextTurnEvents);
      assert.strictEqual(turns[0].week, round + 1);
      if (round === 26) {
        // G6: 第 26 周结束后 waitingForOrders 为空
        assert.deepStrictEqual(turns[0].waitingForOrders, []);
      }
    }

    // G5: 26 周后提交订单被拒绝
    const rejected = await emit(players[0], 'submit order', 4);
    assert.ok(rejected && rejected.err, 'order after week 26 should be rejected');
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// T1-T4: 需求趋势
async function assertDemandTrendSelection(trend, rounds, expectedDemand) {
  const admin = await connectClient();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game', { demandTrend: trend });

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `${trend}-${i + 1}`);
    }
    await Promise.all(gameStartedEvents);

    for (let round = 1; round < rounds; round++) {
      const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
      for (const p of players) await emit(p, 'submit order', 4);
      await Promise.all(nextTurnEvents);
    }

    const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
    for (const p of players) await emit(p, 'submit order', 4);
    const turns = await Promise.all(nextTurnEvents);
    // 零售商（index 0）的下游订单即为客户需求
    assert.strictEqual(
      turns[0].update.role.downstream.orders,
      expectedDemand,
      `${trend} trend at round ${rounds} should have demand ${expectedDemand}`
    );
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// P6: 新玩家加入进行中组的空槽位
async function assertMidGameJoin() {
  const admin = await connectClient();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    // 只加入 3 人，留一个空槽位
    for (let i = 0; i < 3; i++) {
      players.push(await connectClient());
      await emit(players[i], 'submit username', `midgame-${i + 1}`);
    }

    // 第 4 人加入，触发 game started
    const fourth = await connectClient();
    players.push(fourth);
    const gameStartedEvent = once(fourth, 'game started');
    const joinResult = await emit(fourth, 'submit username', 'midgame-4');
    assert.ok(joinResult && joinResult.idx !== undefined, 'fourth player should be assigned a slot');

    const gameStarted = await gameStartedEvent;
    assert.strictEqual(gameStarted.week, 1, 'game should start at week 1');
    assert.deepStrictEqual(gameStarted.waitingForOrders, EXPECTED_ROLES);
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// R4: 顶替时继承游戏数据
async function assertTakeoverInheritsData() {
  const admin = await connectClient();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `takeover-${i + 1}`);
    }
    await Promise.all(gameStartedEvents);

    // 完成第 1 周，让玩家积累一些成本
    const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
    for (const p of players) await emit(p, 'submit order', 4);
    const turns = await Promise.all(nextTurnEvents);
    const originalCost = turns[2].update.cost;

    // player-3（slot 2）断线并等待宽限期结束
    players[2].close();
    await wait(RECONNECT_GRACE_MS + 250);

    // 新玩家顶替 slot 2
    const takeover = await connectClient();
    players.push(takeover);
    const takeoverResult = await emit(takeover, 'submit username', 'takeover-new');
    assert.strictEqual(takeoverResult.idx, 2, 'takeover should land on slot 2');
    assert.strictEqual(
      takeoverResult.group.users[2].cost,
      originalCost,
      'takeover should inherit original player cost'
    );
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// G3, G4: 订单数量验证
async function assertOrderValidation() {
  const admin = await connectClient();
  const players = [];
  try {
    // G4: week=0（waiting 状态）时不可提交订单，也不可登录
    const earlyPlayer = await connectClient();
    try {
      const earlyResult = await emit(earlyPlayer, 'submit username', 'validate-early');
      assert.ok(
        typeof earlyResult === 'string' || (earlyResult && earlyResult.err),
        'login should be rejected in waiting state'
      );
    } finally {
      earlyPlayer.close();
    }

    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `validate-${i + 1}`);
    }
    await Promise.all(gameStartedEvents);

    // G3: 负数被拒绝
    const negativeRejected = await emit(players[0], 'submit order', -1);
    assert.ok(negativeRejected && negativeRejected.err, 'negative order should be rejected');

    // G3: 非整数被拒绝
    const floatRejected = await emit(players[0], 'submit order', 1.5);
    assert.ok(floatRejected && floatRejected.err, 'float order should be rejected');
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

// A7: 重置游戏
async function assertResetGame() {
  const admin = await connectClient();
  const players = [];
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');

    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }
    const gameStartedEvents = players.map((s) => once(s, 'game started'));
    for (let i = 0; i < 4; i++) {
      await emit(players[i], 'submit username', `reset-${i + 1}`);
    }
    await Promise.all(gameStartedEvents);

    const resetEvents = players.map((socket) => once(socket, 'game reset'));
    await emit(admin, 'reset game');
    await Promise.all(resetEvents);

    // 重置后状态清零
    const afterReset = await emit(admin, 'submit password', ADMIN_PASSWORD);
    assert.strictEqual(afterReset.status, 'waiting');
    assert.strictEqual(afterReset.numUsers, 0);
    assert.deepStrictEqual(afterReset.groups, []);
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

async function main() {
  const server = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD,
      MOBILE_RECONNECT_GRACE_MS: String(RECONNECT_GRACE_MS)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer();
    await assertStaticAssets();
    await assertAdminAuth();

    server.kill();
    await wait(500);

    await runIsolated(assertLoginBlockedWhenWaiting);
    await runIsolated(runFullGameFlow);
    await runIsolated(assertDifferentUsernameCannotTakeGraceSeat);
    await runIsolated(assertDisconnectExpiresAfterGrace);
    await runIsolated(assertNoAckCrash);
    await runIsolated(assertWeekLimitStopsOrdersAt26);
    await runIsolated(() => assertDemandTrendSelection('growth', 5, 6));
    await runIsolated(() => assertDemandTrendSelection('decline', 1, 16));
    await runIsolated(() => assertDemandTrendSelection('mixed', 17, 8));
    await runIsolated(assertMidGameJoin);
    await runIsolated(assertTakeoverInheritsData);
    await runIsolated(assertOrderValidation);
    await runIsolated(assertResetGame);
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    server.kill();
  }
}

async function runIsolated(testFn) {
  const server = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD,
      MOBILE_RECONNECT_GRACE_MS: String(RECONNECT_GRACE_MS)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer();
    await testFn();
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    server.kill();
    await wait(500);
  }
}

main()
  .then(() => {
    console.log('integration tests passed');
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
