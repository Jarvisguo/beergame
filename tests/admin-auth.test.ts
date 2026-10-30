import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';

const PASSWORD = 'admin-auth-test-only';
const DENIED = { err: '需要管理员登录。' };
const commands: [string, ...unknown[]][] = [
  ['start game', { demandTrend: 'growth' }],
  ['end game'],
  ['reset game'],
  ['remove group', '0'],
  ['remove member', { groupIndex: 0, roleIndex: 0 }],
  ['add agent', { groupIndex: 0, roleIndex: 1 }],
  ['remove agent', { groupIndex: 0, roleIndex: 1 }],
  ['list agents'],
];

function emit(socket: Socket, event: string, ...args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, ...args, (error: Error | null, result: unknown) => {
      if (error) reject(error); else resolve(result);
    });
  });
}

function connectSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    function cleanup() {
      socket.off('connect', connected);
      socket.off('connect_error', failed);
    }
    function connected() { cleanup(); resolve(); }
    function failed(error: Error) { cleanup(); reject(error); }
    socket.once('connect', connected);
    socket.once('connect_error', failed);
    socket.connect();
  });
}

test('admin commands require authentication on the current connection', { timeout: 30000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: PASSWORD, MOBILE_RECONNECT_GRACE_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets: Socket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test server startup timed out')), 10000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited: ${code}`)); });
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('http://0.0.0.0:')) { clearTimeout(timer); resolve(); }
      });
    });
    async function connect(): Promise<Socket> {
      const socket = io(`http://127.0.0.1:${port}`, { autoConnect: false, reconnection: false, timeout: 3000 });
      sockets.push(socket);
      await connectSocket(socket);
      return socket;
    }
    const admin = await connect();
    const anonymous = await connect();
    const wrongPassword = await connect();
    const snapshot = () => emit(admin, 'submit password', PASSWORD);
    assert.equal((await snapshot()).status, 'waiting');
    assert.equal(await emit(wrongPassword, 'submit password', 'incorrect'), 'Invalid Password');

    async function assertDenied(socket: Socket) {
      const before = await snapshot();
      for (const [event, ...args] of commands) {
        assert.deepEqual(await emit(socket, event, ...args), DENIED, `${event} must be denied`);
        assert.deepEqual(await snapshot(), before, `${event} must not change game state`);
      }
      // Missing arguments and acknowledgements must not bypass the guard or crash a handler.
      for (const [event] of commands) socket.emit(event);
      assert.equal(await emit(socket, 'submit password', 'incorrect'), 'Invalid Password');
      assert.deepEqual(await snapshot(), before, 'fire-and-forget commands must have no side effects');
    }
    await assertDenied(anonymous);
    await assertDenied(wrongPassword);

    assert.equal((await emit(admin, 'start game')).numUsers, 0);
    const player = await connect();
    assert.equal((await emit(player, 'submit username', 'classroom-player')).idx, 0);
    await assertDenied(player);

    const agent = { groupIndex: 0, roleIndex: 1, strategy: 'default' };
    assert.equal((await emit(admin, 'add agent', agent)).ok, true);
    assert.equal((await emit(admin, 'list agents')).length, 1);
    assert.equal((await emit(admin, 'remove agent', agent)).ok, true);
    assert.equal((await emit(admin, 'list agents')).length, 0);
    assert.equal((await emit(admin, 'add agent', agent)).ok, true);
    assert.equal((await emit(admin, 'remove member', agent)).ok, true);
    assert.equal((await emit(admin, 'remove group', '0')).groups.length, 0);
    assert.equal((await emit(admin, 'end game')).numUsers, 0);
    assert.equal((await emit(admin, 'reset game')).groups.length, 0);

    const oldID = admin.id;
    admin.disconnect();
    await connectSocket(admin);
    assert.notEqual(admin.id, oldID);
    assert.deepEqual(await emit(admin, 'list agents'), DENIED, 'reconnection must require a fresh login');
    assert.equal((await snapshot()).status, 'waiting');
    assert.equal((await emit(admin, 'start game')).numUsers, 0);
  } finally {
    sockets.forEach(socket => socket.close());
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});
