const assert = require('assert');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const http = require('http');

const PORT = Number(process.env.TEST_PORT || 3222);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-secret';

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      http.get(`${BASE_URL}/`, res => {
        res.resume();
        res.on('end', resolve);
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
    socket.once(event, (...args) => {
      clearTimeout(t);
      resolve(...args);
    });
  });
}

async function setupStartedGroup(prefix) {
  const admin = await connect();
  await emit(admin, 'submit password', ADMIN_PASSWORD);
  await emit(admin, 'start game');

  const players = [];
  for (let i = 0; i < 4; i++) players.push(await connect());
  const startedEvents = players.map(s => once(s, 'game started'));
  for (let i = 0; i < 4; i++) {
    await emit(players[i], 'submit username', `${prefix}-${i + 1}`);
  }
  await Promise.all(startedEvents);
  return { admin, players };
}

async function assertAdminCanRemoveHumanAndSameNameRejoinsAsNew() {
  const { admin, players } = await setupStartedGroup('removed-human');
  try {
    const nextTurnEvents = players.map(s => once(s, 'next turn'));
    for (const player of players) await emit(player, 'submit order', 7);
    const turns = await Promise.all(nextTurnEvents);
    assert(turns[0].update.cost > 0, 'fixture should create non-zero old state before removal');

    const kicked = once(players[0], 'kicked out');
    const removed = await emit(admin, 'remove member', {
      groupIndex: 0,
      roleIndex: 0,
      reason: 'stuck',
    });
    await kicked;

    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.groups[0].week, 2, 'removal should not advance the game week');
    assert.strictEqual(removed.groups[0].users[0].socketId, undefined);
    assert.strictEqual(removed.groups[0].users[0].removed, true);

    const oldSubmit = await emit(players[0], 'submit order', 5);
    assert(oldSubmit && oldSubmit.err, 'removed socket should not be able to keep playing');

    const rejoin = await emit(players[0], 'submit username', 'removed-human-1');
    assert.strictEqual(rejoin.reconnected, false, 'removed player must not use reconnect flow');
    assert.strictEqual(rejoin.idx, 0);
    assert.strictEqual(rejoin.group.users[0].name, 'removed-human-1');
    assert.strictEqual(rejoin.group.users[0].cost, 0, 'same username should enter with fresh member state');
    assert.strictEqual(rejoin.group.users[0].inventory, 12);
    assert.strictEqual(rejoin.group.users[0].removed, undefined);
  } finally {
    admin.close();
    players.forEach(s => s && s.close());
  }
}

async function assertAdminCanRemoveAgentWithoutAutoBackfill() {
  const admin = await connect();
  try {
    await emit(admin, 'submit password', ADMIN_PASSWORD);
    await emit(admin, 'start game');
    await emit(admin, 'add agent', { groupIndex: 0, roleIndex: 0, strategy: 'default', params: {} });

    const before = await emit(admin, 'submit password', ADMIN_PASSWORD);
    assert(before.groups[0].users[0].agent, 'fixture should have an agent before removal');

    const removed = await emit(admin, 'remove member', {
      groupIndex: 0,
      roleIndex: 0,
      reason: 'admin',
    });

    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.groups[0].users[0].agent, undefined);
    assert.strictEqual(removed.groups[0].users[0].removed, true);

    await wait(300);
    const after = await emit(admin, 'submit password', ADMIN_PASSWORD);
    assert.strictEqual(after.groups[0].users[0].agent, undefined, 'removed agent should not auto-backfill');
  } finally {
    admin.close();
  }
}

async function runIsolated(name, testFn) {
  const server = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD,
      MOBILE_RECONNECT_GRACE_MS: '700',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForServer();
    console.log(`  running ${name}...`);
    await testFn();
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    server.kill();
    await wait(400);
  }
}

async function main() {
  console.log('admin remove member tests');
  await runIsolated('remove human and rejoin as new', assertAdminCanRemoveHumanAndSameNameRejoinsAsNew);
  await runIsolated('remove agent without auto-backfill', assertAdminCanRemoveAgentWithoutAutoBackfill);
  console.log('admin remove member tests passed');
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
