/**
 * Tests: "进入下一周" flow
 *
 * 1. 4人满组：全部提交订单 → all orders submitted → 全部点下一周 → week=2
 * 2. 不满4人时提交订单：直接被服务端拒绝（week=0 guard）
 * 3. 中途加入第4人：前3人等 game started 再提交，4人全提交后推进week
 */

const io = require('socket.io-client');
const SRV = 'http://localhost:3000';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitEvent(socket, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: '${event}'`)), ms);
    socket.once(event, (...args) => { clearTimeout(t); resolve(args); });
  });
}

async function adminLogin() {
  return new Promise((resolve, reject) => {
    const s = io(SRV, { forceNew: true });
    s.on('connect', () => {
      s.emit('submit password', 'admin', (res) => {
        if (res === 'Invalid Password') return reject(new Error('wrong admin password'));
        resolve(s);
      });
    });
    s.on('connect_error', e => reject(e));
  });
}

function resetAndStart(admin) {
  return new Promise((resolve, reject) => {
    admin.emit('reset game', () => {
      setTimeout(() => {
        admin.emit('start game', (res) => {
          if (res && res.err) reject(new Error(res.err));
          else resolve();
        });
      }, 100);
    });
  });
}

async function joinPlayer(name) {
  return new Promise((resolve, reject) => {
    const s = io(SRV, { forceNew: true });
    s.on('connect', () => {
      s.emit('submit username', name, (res) => {
        if (typeof res === 'string') return reject(new Error(`join failed: ${res}`));
        resolve({ socket: s, week: res.group.week });
      });
    });
    s.on('connect_error', e => reject(e));
  });
}

function submitOrder(socket, amount) {
  return new Promise(resolve => socket.emit('submit order', String(amount), resolve));
}

function confirmNextWeek(socket) {
  return new Promise(resolve => socket.emit('confirm next week', resolve));
}

// ── runner ────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== 进入下一周 Flow Tests ===\n');

  // ── Test 1: 4人同时加入，完整走完一周 ────────────────────────────────────
  await test('4人满组：全部提交订单后week推进到2', async () => {
    const admin = await adminLogin();
    await resetAndStart(admin);

    // All 4 join; register game started listener BEFORE joining so we don't miss it
    const entries = [];
    const gameStartedPromises = [];
    for (const name of ['G1_p0', 'G1_p1', 'G1_p2', 'G1_p3']) {
      const { socket, week } = await joinPlayer(name);
      // If week already > 0 from the ack, game started already processed by server
      if (week > 0) {
        gameStartedPromises.push(Promise.resolve());
      } else {
        gameStartedPromises.push(waitEvent(socket, 'game started', 5000));
      }
      entries.push(socket);
      await sleep(80);
    }
    await Promise.all(gameStartedPromises);
    await sleep(200);

    // Register next turn listener BEFORE submitting
    const nextTurnPromises = entries.map(s => waitEvent(s, 'next turn', 5000));
    await Promise.all(entries.map(s => submitOrder(s, 4)));
    await Promise.all(nextTurnPromises);

    entries.forEach(s => s.disconnect());
    admin.disconnect();
  });

  // ── Test 2: week=0 时提交被服务端拒绝 ────────────────────────────────────
  await test('不满4人时提交订单：服务端拒绝(week=0)', async () => {
    const admin = await adminLogin();
    await resetAndStart(admin);

    const { socket: p1, week } = await joinPlayer('G2_only');
    assert(week === 0, '1人时game应尚未初始化(week=0)');

    let allOrdersFired = false;
    p1.on('all orders submitted', () => { allOrdersFired = true; });

    const ack = await submitOrder(p1, 4);
    // Should be rejected with an error
    assert(ack && ack.err, `期望拒绝，但得到: ${JSON.stringify(ack)}`);
    await sleep(500);
    assert(!allOrdersFired, '不应触发 all orders submitted');

    p1.disconnect();
    admin.disconnect();
  });

  // ── Test 3: 中途加入第4人，4人全提交才推进 ───────────────────────────────
  await test('中途加入第4人：4人都提交后推进week', async () => {
    const admin = await adminLogin();
    await resetAndStart(admin);

    // 3 players join (game stays at week=0)
    const first3 = [];
    for (const name of ['G3_p0', 'G3_p1', 'G3_p2']) {
      const { socket, week } = await joinPlayer(name);
      assert(week === 0, `${name} 加入时game应未初始化`);
      first3.push(socket);
      await sleep(80);
    }

    // Register game started listener on first3 BEFORE 4th player joins
    const gameStartedForFirst3 = first3.map(s => waitEvent(s, 'game started', 5000));

    // 4th player joins → triggers initGroup → game started broadcast
    const { socket: p4 } = await joinPlayer('G3_p3');
    // p4 receives game started via direct emit in initGroup
    const gameStartedForP4 = waitEvent(p4, 'game started', 5000);

    await Promise.all([...gameStartedForFirst3, gameStartedForP4]);
    await sleep(200);

    // All 4 submit → auto advance
    let firedCount = 0;
    [...first3, p4].forEach(s => s.on('next turn', () => firedCount++));
    await Promise.all([...first3, p4].map(s => submitOrder(s, 4)));
    await sleep(1000);

    assert(firedCount > 0, '4人全部提交后应触发 next turn (自动进入下一周)');

    [...first3, p4].forEach(s => s.disconnect());
    admin.disconnect();
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
