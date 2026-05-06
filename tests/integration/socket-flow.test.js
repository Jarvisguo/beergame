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

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function assertStaticAssets() {
  for (const path of ['/', '/admin.html', '/report.html', '/socket.io/socket.io.js']) {
    assert.strictEqual(await request(path), 200, `${path} should load`);
  }
}

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

async function assertStartGuard() {
  const admin = await connectClient();
  const player = await connectClient();
  try {
    await emit(player, 'submit username', 'guard-player');
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    const response = await emit(admin, 'start game');
    assert(response.err, 'starting with fewer than four players should fail');
  } finally {
    admin.close();
    player.close();
  }
}

async function assertIncompleteGroupCannotStart() {
  const admin = await connectClient();
  const players = [];
  try {
    for (let i = 0; i < 5; i++) {
      players.push(await connectClient());
      await emit(players[i], 'submit username', `incomplete-${i + 1}`);
    }

    await emit(admin, 'submit password', ADMIN_PASSWORD);
    const response = await emit(admin, 'start game');
    assert(response.err, 'starting with an incomplete second group should fail');
  } finally {
    admin.close();
    players.forEach((socket) => socket.close());
  }
}

async function runFullGameFlow() {
  const admin = await connectClient();
  const players = [];
  try {
    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
    }

    const registrations = [];
    for (let i = 0; i < players.length; i++) {
      registrations.push(await emit(players[i], 'submit username', `player-${i + 1}`));
    }

    const roles = registrations.map((msg) => msg.group.users[msg.idx].role.name);
    assert.deepStrictEqual(roles, EXPECTED_ROLES);

    const duplicate = await connectClient();
    try {
      assert.strictEqual(await emit(duplicate, 'submit username', 'player-1'), 'Invalid Username');
    } finally {
      duplicate.close();
    }

    const startedEvents = players.map((socket) => once(socket, 'game started'));
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    const startResponse = await emit(admin, 'start game');
    assert.strictEqual(startResponse.numUsers, 4);

    const started = await Promise.all(startedEvents);
    started.forEach((msg) => {
      assert.strictEqual(msg.week, 1);
      assert.deepStrictEqual(msg.waitingForOrders, EXPECTED_ROLES);
    });

    const firstWaitingList = await emit(players[0], 'submit order', 4);
    assert.deepStrictEqual(firstWaitingList, ['批发商', '区域仓库', '工厂']);

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

    players[2].close();
    await wait(100);
    const adminSnapshot = await emit(admin, 'submit password', ADMIN_PASSWORD);
    assert.strictEqual(adminSnapshot.numUsers, 4, 'disconnect grace should keep player counted');
    assert(adminSnapshot.groups[0].users[2].socketId, 'socketId should remain during grace');

    const reconnect = await connectClient();
    players[2] = reconnect;
    const rejoined = await emit(reconnect, 'submit username', 'player-3');
    assert.strictEqual(rejoined.idx, 2);
    assert.strictEqual(rejoined.group.users[2].role.name, '区域仓库');
    assert.strictEqual(rejoined.group.week, 2);

    const resetEvents = players.map((socket) => once(socket, 'game reset'));
    const reset = await emit(admin, 'reset game');
    assert.strictEqual(reset.numUsers, 4);
    await Promise.all(resetEvents);

    const restartedEvents = players.map((socket) => once(socket, 'game started'));
    const restart = await emit(admin, 'start game');
    assert.strictEqual(restart.numUsers, 4);
    await Promise.all(restartedEvents);

    const endedEvents = players.map((socket) => once(socket, 'game ended'));
    const ended = await emit(admin, 'end game');
    assert.strictEqual(ended.numUsers, 4);
    await Promise.all(endedEvents);
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

async function assertDifferentUsernameCannotTakeGraceSeat() {
  const players = [];
  try {
    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
      await emit(players[i], 'submit username', `reserved-${i + 1}`);
    }

    players[2].close();
    await wait(100);

    const replacement = await connectClient();
    players.push(replacement);
    const replacementJoin = await emit(replacement, 'submit username', 'reserved-replacement');
    assert.strictEqual(replacementJoin.group.users[0].name, 'reserved-replacement');
    assert.strictEqual(replacementJoin.idx, 0, 'different usernames should start a new group');
    assert.strictEqual(replacementJoin.group.users[0].role.name, '零售商');

    const reconnect = await connectClient();
    players.push(reconnect);
    const rejoined = await emit(reconnect, 'submit username', 'reserved-3');
    assert.strictEqual(rejoined.idx, 2);
    assert.strictEqual(rejoined.group.users[2].role.name, '区域仓库');
  } finally {
    players.forEach((socket) => socket && socket.close());
  }
}

async function assertDisconnectExpiresAfterGrace() {
  const admin = await connectClient();
  const players = [];
  try {
    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
      await emit(players[i], 'submit username', `expire-${i + 1}`);
    }

    await emit(admin, 'submit password', ADMIN_PASSWORD);
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

async function assertGraceAllowsStart() {
  const admin = await connectClient();
  const players = [];
  try {
    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
      await emit(players[i], 'submit username', `grace-start-${i + 1}`);
    }

    await emit(admin, 'submit password', ADMIN_PASSWORD);
    const startedEvents = players.slice(0, 3).map((socket) => once(socket, 'game started'));
    players[3].close();
    await wait(100);

    const start = await emit(admin, 'start game');
    assert.strictEqual(start.numUsers, 4, 'grace-period disconnect should count as online');
    await Promise.all(startedEvents);
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

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

async function assertWeekLimitStopsOrdersAt26() {
  const admin = await connectClient();
  const players = [];
  try {
    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
      await emit(players[i], 'submit username', `limit-${i + 1}`);
    }

    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await Promise.all(players.map((socket) => once(socket, 'game started')).concat([emit(admin, 'start game')]));

    for (let round = 1; round <= 26; round++) {
      const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
      for (let i = 0; i < players.length; i++) {
        await emit(players[i], 'submit order', 4);
      }
      const turns = await Promise.all(nextTurnEvents);
      assert.strictEqual(turns[0].week, round + 1);
      if (round === 26) {
        assert.deepStrictEqual(turns[0].waitingForOrders, []);
      }
    }

    const rejected = await emit(players[0], 'submit order', 4);
    assert.deepStrictEqual(rejected, { err: 'Game has completed 26 weeks. No more orders accepted.' });
  } finally {
    admin.close();
    players.forEach((socket) => socket && socket.close());
  }
}

async function assertDemandTrendSelection(trend, rounds, expectedDemand) {
  const admin = await connectClient();
  const players = [];
  try {
    for (let i = 0; i < 4; i++) {
      players.push(await connectClient());
      await emit(players[i], 'submit username', `${trend}-${i + 1}`);
    }

    await emit(admin, 'submit password', ADMIN_PASSWORD);
    const startedEvents = players.map((socket) => once(socket, 'game started'));
    const startResponse = await emit(admin, 'start game', { demandTrend: trend });
    assert.strictEqual(startResponse.demandTrend, trend);
    const started = await Promise.all(startedEvents);
    started.forEach((msg) => {
      assert.strictEqual(msg.demandTrend, trend);
      assert.strictEqual(msg.demandProfile.name.length > 0, true);
    });

    let turns = [];
    for (let round = 1; round <= rounds; round++) {
      const nextTurnEvents = players.map((socket) => once(socket, 'next turn'));
      for (let i = 0; i < players.length; i++) {
        await emit(players[i], 'submit order', 4);
      }
      turns = await Promise.all(nextTurnEvents);
    }

    assert.strictEqual(turns[0].update.role.downstream.orders, expectedDemand, `${trend} demand at round ${rounds}`);
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
  server.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForServer();
    await assertStaticAssets();
    await assertAdminAuth();

    server.kill();
    await wait(500);

    await runIsolated(assertStartGuard);
    await runIsolated(assertIncompleteGroupCannotStart);
    await runIsolated(runFullGameFlow);
    await runIsolated(assertDifferentUsernameCannotTakeGraceSeat);
    await runIsolated(assertDisconnectExpiresAfterGrace);
    await runIsolated(assertGraceAllowsStart);
    await runIsolated(assertNoAckCrash);
    await runIsolated(assertWeekLimitStopsOrdersAt26);
    await runIsolated(() => assertDemandTrendSelection('growth', 5, 6));
    await runIsolated(() => assertDemandTrendSelection('decline', 1, 16));
    await runIsolated(() => assertDemandTrendSelection('mixed', 17, 8));
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
  server.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

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
