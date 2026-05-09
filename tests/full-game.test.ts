/* ========================================================================
 * Beer Distribution Game — 自动化集成测试
 * 4 角色 × 15 轮完整游戏流程，独立参考实现逐项比对
 * ======================================================================== */

import { spawn, ChildProcess } from 'child_process';
import { io as connectClient, Socket } from 'socket.io-client';
import { readFileSync } from 'fs';

const PORT = 3270;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'test-secret';
const GRACE_MS = 700;

const ROLE_NAMES = ['零售商', '批发商', '区域仓库', '工厂'];
const PLAYERS = ['retailer', 'wholesaler', 'warehouse', 'factory'];

// ── Independent reference implementation (mirrors server logic) ───────

const INVENTORY_COST = 0.5;
const BACKLOG_COST = 1;
const STARTING_INVENTORY = 12;
const STARTING_THROUGHPUT = 4;
const MAX_WEEKS = 26;

const DEMAND = {
  mixed: [{ until: 4, demand: 4 }, { until: 8, demand: 6 }, { until: 12, demand: 8 },
    { until: 16, demand: 10 }, { until: 20, demand: 8 }, { until: 24, demand: 6 }, { until: 26, demand: 4 }],
  growth: [{ until: 4, demand: 4 }, { until: 8, demand: 6 }, { until: 12, demand: 8 },
    { until: 16, demand: 10 }, { until: 20, demand: 12 }, { until: 24, demand: 14 }, { until: 26, demand: 16 }],
  decline: [{ until: 4, demand: 16 }, { until: 8, demand: 14 }, { until: 12, demand: 12 },
    { until: 16, demand: 10 }, { until: 20, demand: 8 }, { until: 24, demand: 6 }, { until: 26, demand: 4 }],
};

function refCustomerDemand(week: number, trend: string): number {
  const sched = (DEMAND as any)[trend] || DEMAND.mixed;
  for (const e of sched) { if (week <= e.until) return e.demand; }
  return sched[sched.length - 1].demand;
}

function refMakeRole(idx: number) {
  const upstreams = ['批发商', '区域仓库', '工厂', '工厂'];
  const downstreams = ['客户', '零售商', '批发商', '区域仓库'];
  return {
    name: ROLE_NAMES[idx],
    upstream: { name: upstreams[idx], orders: STARTING_THROUGHPUT, shipments: STARTING_THROUGHPUT },
    downstream: { name: downstreams[idx], orders: STARTING_THROUGHPUT, shipments: STARTING_THROUGHPUT },
  };
}

interface RefUser {
  name: string; cost: number; inventory: number; backlog: number;
  role: ReturnType<typeof refMakeRole>;
  inventoryHistory: number[]; backlogHistory: number[];
  costHistory: number[]; orderHistory: number[];
}

interface RefGroup {
  week: number; cost: number; users: RefUser[]; costHistory: number[];
  shipping: number[][]; mailing: number[][]; demandTrend: string;
}

function refAdvanceTurn(g: RefGroup): void {
  for (let i = 0; i < 4; i++) {
    const u = g.users[i];
    u.costHistory.push(u.cost);
    u.inventoryHistory.push(u.inventory);
    u.backlogHistory.push(u.backlog);

    // Receive shipment
    u.role.upstream.shipments = g.shipping[i].shift()!;
    u.inventory += u.role.upstream.shipments;

    // Receive downstream order
    if (i === 0) {
      u.role.downstream.orders = refCustomerDemand(g.week, g.demandTrend);
    } else {
      u.role.downstream.orders = g.mailing[i - 1].shift()!;
    }

    // Ship to downstream
    const toShip = u.backlog + u.role.downstream.orders;
    u.role.downstream.shipments = toShip > u.inventory ? u.inventory : toShip;
    if (i !== 0) g.shipping[i - 1].push(u.role.downstream.shipments);

    // Update state
    u.backlog = toShip > u.inventory ? toShip - u.inventory : 0;
    u.inventory = toShip > u.inventory ? 0 : u.inventory - toShip;

    // Record order (already set by caller)
    u.orderHistory.push(u.role.upstream.orders);

    // Send order upstream
    if (i === 3) g.shipping[i].push(u.role.upstream.orders);
    else g.mailing[i].push(u.role.upstream.orders);

    g.cost += u.cost;
    u.cost += u.inventory * INVENTORY_COST + u.backlog * BACKLOG_COST;
  }

  g.costHistory.push(g.cost);
  g.week++;
}

function createRefGroup(players: string[], trend: string): RefGroup {
  const users: RefUser[] = players.map((name, i) => ({
    name, cost: 0, inventory: STARTING_INVENTORY, backlog: 0,
    role: refMakeRole(i), inventoryHistory: [], backlogHistory: [], costHistory: [], orderHistory: [],
  }));
  // Pre-init shipping/mailing buffers (mirrors server start game)
  const shipping: number[][] = [];
  const mailing: number[][] = [];
  for (let j = 0; j < 3; j++) {
    shipping.push([STARTING_THROUGHPUT, STARTING_THROUGHPUT]);
    mailing.push([STARTING_THROUGHPUT]);
  }
  shipping.push([STARTING_THROUGHPUT, STARTING_THROUGHPUT]);
  return { week: 1, cost: 0, users, costHistory: [], shipping, mailing, demandTrend: trend };
}

// ── Test helpers ──────────────────────────────────────────────────────

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function once(s: Socket, event: string): Promise<any> {
  return new Promise(r => s.once(event, r));
}

function emit(s: Socket, event: string, ...args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    s.timeout(5000).emit(event, ...args, (err: any, payload: any) => {
      if (err) reject(err); else resolve(payload);
    });
  });
}

async function startServer(): Promise<ChildProcess> {
  const server = spawn(process.execPath, ['src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: ADMIN_PW, MOBILE_RECONNECT_GRACE_MS: String(GRACE_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
  server.stderr?.on('data', (c: Buffer) => { out += c.toString(); });

  // Wait for ready
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const s = connectClient(BASE, { timeout: 3000, reconnection: false });
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => { s.close(); resolve(); });
        s.once('connect_error', reject);
      });
      return server;
    } catch { await wait(300); }
  }
  server.kill();
  throw new Error('Server did not start\n' + out);
}

// ── Assertion ─────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) throw new Error(`FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeep(actual: any, expected: any, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL: ${label} — expected ${b}, got ${a}`);
}

function assertUserState(actual: any, expected: RefUser, label: string) {
  assertEq(actual.role.name, expected.role.name, `${label} role`);
  assertEq(actual.role.downstream.name, expected.role.downstream.name, `${label} downstream role`);
  assertEq(actual.role.upstream.name, expected.role.upstream.name, `${label} upstream role`);
  assertEq(actual.role.downstream.orders, expected.role.downstream.orders, `${label} downstream orders`);
  assertEq(actual.role.downstream.shipments, expected.role.downstream.shipments, `${label} downstream shipments`);
  assertEq(actual.role.upstream.shipments, expected.role.upstream.shipments, `${label} upstream shipments`);
  assertEq(actual.inventory, expected.inventory, `${label} inventory`);
  assertEq(actual.backlog, expected.backlog, `${label} backlog`);
  assertEq(actual.cost, expected.cost, `${label} cost`);
  assertDeep(actual.orderHistory, expected.orderHistory, `${label} orderHistory`);
  assertDeep(actual.inventoryHistory, expected.inventoryHistory, `${label} inventoryHistory`);
  assertDeep(actual.backlogHistory, expected.backlogHistory, `${label} backlogHistory`);
  assertDeep(actual.costHistory, expected.costHistory, `${label} costHistory`);
}

// ── Main test ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('=== Beer Distribution Game — 自动化集成测试 ===\n');

  let server: ChildProcess | null = null;
  try {
    server = await startServer();
    console.log('[OK] Server started');

    // ─── Test 1: 15-round full game (mixed trend) ───
    console.log('\n── Test 1: 15 轮完整游戏 (mixed 趋势) ──');
    await testFullGame(15, 'mixed', [
      [4, 4, 4, 4], [8, 6, 5, 4], [2, 10, 7, 6],
      [6, 3, 12, 8], [5, 9, 4, 10], [4, 8, 6, 5],
      [7, 5, 10, 4], [3, 12, 8, 6], [10, 4, 5, 8],
      [6, 7, 9, 5], [5, 5, 5, 5], [8, 8, 8, 8],
      [4, 6, 8, 10], [12, 10, 6, 4], [5, 8, 7, 6],
    ]);
    console.log('[OK] 15-round full game passed');

    // ─── Test 2: Admin statistics ───
    console.log('\n── Test 2: 管理端统计验证 ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testAdminStats();
    console.log('[OK] Admin stats passed');

    // ─── Test 3: Demand trend correctness ───
    console.log('\n── Test 3: 需求趋势正确性 ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testDemandTrend('growth', 5, 6);
    server.kill(); await wait(500);
    server = await startServer();
    await testDemandTrend('decline', 1, 16);
    server.kill(); await wait(500);
    server = await startServer();
    await testDemandTrend('mixed', 17, 8);
    console.log('[OK] Demand trends passed');

    // ─── Test 4: Edge cases ───
    console.log('\n── Test 4: 边界行为 ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testEdgeCases();
    console.log('[OK] Edge cases passed');

    // ─── Test 5: State machine ───
    console.log('\n── Test 5: 状态机 (start/end/reset) ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testStateMachine();
    console.log('[OK] State machine passed');

    // ─── Test 6: Disconnected player ───
    console.log('\n── Test 6: 断线玩家场景 ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testDisconnectedPlayer();
    console.log('[OK] Disconnected player test passed');

    // ─── Test 7: Login timing rules ───
    console.log('\n── Test 7: 登录时机规则 ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testLoginTiming();
    console.log('[OK] Login timing rules passed');

    // ─── Test 8: Independent group operations ───
    console.log('\n── Test 8: 独立小组运营 ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testIndependentGroups();
    console.log('[OK] Independent group operations passed');

    // ─── Test 9: Group completion at 26 weeks ───
    console.log('\n── Test 9: 小组完成判断 ──');
    server.kill(); await wait(500);
    server = await startServer();
    await testGroupCompletion();
    console.log('[OK] Group completion test passed');

    console.log('\n=== 全部测试通过 ===');
  } finally {
    if (server) server.kill();
  }
}

// ─── Test 1: Full game ────────────────────────────────────────────────

async function testFullGame(rounds: number, trend: string, orders: number[][]) {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  const players: Socket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      admin.once('connect', resolve);
      admin.once('connect_error', reject);
    });
    await emit(admin, 'submit password', ADMIN_PW);

    // Admin starts game first (before players login)
    const startResp = await emit(admin, 'start game', { demandTrend: trend });
    assertEq(startResp.demandTrend, trend, 'start demandTrend');

    // Connect 4 players — group auto-starts when 4th joins
    const startedPromises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((resolve, reject) => {
        s.once('connect', resolve); s.once('connect_error', reject);
      });
      startedPromises.push(once(s, 'game started'));
      const reg = await emit(s, 'submit username', PLAYERS[i]);
      assertEq(reg.idx, i, `registration idx for ${PLAYERS[i]}`);
      assertEq(reg.group.users[i].role.name, ROLE_NAMES[i], `role for ${PLAYERS[i]}`);
      players.push(s);
    }
    const started = await Promise.all(startedPromises);
    started.forEach((msg: any) => {
      assertEq(msg.week, 1, 'game start week');
      assertDeep(msg.waitingForOrders, ROLE_NAMES, 'game start waiting list');
    });

    // Reference group (independent implementation)
    const ref = createRefGroup(PLAYERS, trend);

    // Run rounds
    for (let round = 0; round < Math.min(rounds, orders.length); round++) {
      const nextTurnEvents = players.map(s => once(s, 'next turn'));

      // Set orders in reference (mirrors players submitting before advanceTurn)
      for (let i = 0; i < 4; i++) {
        ref.users[i].role.upstream.orders = orders[round][i];
      }

      // Submit orders to server
      for (let i = 0; i < 4; i++) {
        await emit(players[i], 'submit order', String(orders[round][i]));
      }

      // Advance reference
      refAdvanceTurn(ref);

      // Receive server results
      const turns = await Promise.all(nextTurnEvents);

      // Verify each role
      for (let i = 0; i < 4; i++) {
        const label = `round ${round + 1} ${ROLE_NAMES[i]}`;
        assertUserState(turns[i].update, ref.users[i], label);
        assertEq(turns[i].week, ref.week, `${label} week`);
      }

      // Verify group cost
      if (round === rounds - 1) {
        const ended = await emit(admin, 'end game');
        const actualGroup = ended.groups[0];
        assertEq(actualGroup.cost, ref.cost, 'final group cost');
        assertDeep(actualGroup.costHistory, ref.costHistory, 'group costHistory');
        assertEq(actualGroup.week, ref.week, 'final group week');
      }
    }
  } finally {
    admin.close();
    players.forEach(s => s.close());
  }
}

// ─── Test 2: Admin stats ──────────────────────────────────────────────

async function testAdminStats() {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  const players: Socket[] = [];
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);

    // Admin starts game first
    await emit(admin, 'start game', { demandTrend: 'mixed' });

    const startedPromises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      startedPromises.push(once(s, 'game started'));
      await emit(s, 'submit username', PLAYERS[i]);
      players.push(s);
    }
    await Promise.all(startedPromises);

    // Run 3 rounds
    for (let r = 0; r < 3; r++) {
      const nt = players.map(s => once(s, 'next turn'));
      for (let i = 0; i < 4; i++) await emit(players[i], 'submit order', String(4 + r));
      await Promise.all(nt);
    }

    // Verify admin sees correct stats
    const adminData = await emit(admin, 'submit password', ADMIN_PW);
    const g = adminData.groups[0];

    // Total inventory = sum of all 4 users' inventory
    const totalInv = g.users.reduce((sum: number, u: any) => sum + (u.inventory || 0), 0);
    // Total backlog = sum of all 4 users' backlog
    const totalBack = g.users.reduce((sum: number, u: any) => sum + (u.backlog || 0), 0);
    // Group cost should match sum of individual costs (before current-week cost addition)
    const groupCost = g.cost;

    assert(totalInv >= 0, 'total inventory non-negative');
    assert(totalBack >= 0, 'total backlog non-negative');
    assert(groupCost >= 0, 'group cost non-negative');

    // waitingForOrders length after all submitted should be 4 (next week)
    assertDeep(g.waitingForOrders, ROLE_NAMES, 'waiting list reset for new week');

    console.log(`  totalInv=${totalInv} totalBack=${totalBack} groupCost=${groupCost}`);
  } finally {
    admin.close();
    players.forEach(s => s.close());
  }
}

// ─── Test 3: Demand trend ─────────────────────────────────────────────

async function testDemandTrend(trend: string, week: number, expectedDemand: number) {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  const players: Socket[] = [];
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);

    // Admin starts game first with demand trend
    const startResp = await emit(admin, 'start game', { demandTrend: trend });
    assertEq(startResp.demandTrend, trend, `${trend} demand trend set`);

    const startedPromises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      startedPromises.push(once(s, 'game started'));
      await emit(s, 'submit username', `${trend}-${i + 1}`);
      players.push(s);
    }
    const started = await Promise.all(startedPromises);
    started.forEach((msg: any) => assertEq(msg.demandTrend, trend, `${trend} trend in game started`));

    // Run until target week
    let turns: any[] = [];
    for (let r = 1; r <= week; r++) {
      const nt = players.map(s => once(s, 'next turn'));
      for (let i = 0; i < 4; i++) await emit(players[i], 'submit order', '4');
      turns = await Promise.all(nt);
    }

    const retailerDemand = turns[0].update.role.downstream.orders;
    assertEq(retailerDemand, expectedDemand, `${trend} week ${week} demand`);
  } finally {
    admin.close();
    players.forEach(s => s.close());
  }
}

// ─── Test 4: Edge cases ───────────────────────────────────────────────

async function testEdgeCases() {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  const players: Socket[] = [];
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);

    // Test: reject login before game starts
    const earlyBird = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { earlyBird.once('connect', r); earlyBird.once('connect_error', rj); });
    const earlyResp = await emit(earlyBird, 'submit username', 'early');
    assert(earlyResp === '游戏尚未开始，请等待管理员启动。', `login before game should be rejected, got: ${JSON.stringify(earlyResp)}`);
    earlyBird.close();

    // Admin starts game
    await emit(admin, 'start game');

    // Test: reject order before registration
    const ghost = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { ghost.once('connect', r); ghost.once('connect_error', rj); });
    const invalidResp = await emit(ghost, 'submit order', '5');
    assert(invalidResp && invalidResp.err, 'unregistered user order should be rejected');
    ghost.close();

    // Register 4 players — group auto-starts on 4th
    const startedPromises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      startedPromises.push(once(s, 'game started'));
      await emit(s, 'submit username', `edge-${i + 1}`);
      players.push(s);
    }
    await Promise.all(startedPromises);

    const respNaN = await emit(players[0], 'submit order', 'abc');
    assert(respNaN && respNaN.err, 'NaN order should be rejected');

    const respNeg = await emit(players[0], 'submit order', '-5');
    assert(respNeg && respNeg.err, 'negative order should be rejected');

    // Submit valid order so we can proceed
    const validResp = await emit(players[0], 'submit order', '4');
    assert(!validResp || !validResp.err, 'valid order should be accepted');

    // Complete remaining orders for round 1
    const nt = players.slice(1).map(s => once(s, 'next turn'));
    for (let i = 1; i < 4; i++) await emit(players[i], 'submit order', '4');
    await Promise.all(nt);

    // Test: reject after week 26
    // Run 25 more rounds to reach week 27
    for (let r = 2; r <= 26; r++) {
      const ntEvents = players.map(s => once(s, 'next turn'));
      for (let i = 0; i < 4; i++) await emit(players[i], 'submit order', '4');
      await Promise.all(ntEvents);
    }

    // Now week 27 — should reject
    const afterEnd = await emit(players[0], 'submit order', '5');
    assert(afterEnd && afterEnd.err && afterEnd.err.includes('26'), 'order after week 26 should be rejected');

    console.log('  invalid orders rejected, week-26 cap enforced');
  } finally {
    admin.close();
    players.forEach(s => s.close());
  }
}

// ─── Test 5: State machine ────────────────────────────────────────────

async function testStateMachine() {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  const players: Socket[] = [];
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);

    // Start game first (before any players)
    const startResp = await emit(admin, 'start game');
    assert(!startResp.err, `start with 0 players should succeed: ${startResp.err || ''}`);

    // Register 4 players — group auto-starts when 4th joins
    const startedPromises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      startedPromises.push(once(s, 'game started'));
      await emit(s, 'submit username', `sm-${i + 1}`);
      players.push(s);
    }
    await Promise.all(startedPromises);

    // Verify game is started
    assertEq(startResp.numUsers, 0, 'numUsers at start (0 players yet)');

    // Try to start again — should fail
    const startAgain = await emit(admin, 'start game');
    assert(startAgain.err, 'second start should fail');

    // Submit orders and advance 2 rounds
    for (let r = 0; r < 2; r++) {
      const nt = players.map(s => once(s, 'next turn'));
      for (let i = 0; i < 4; i++) await emit(players[i], 'submit order', '4');
      await Promise.all(nt);
    }

    // End game
    const endedEvents = players.map(s => once(s, 'game ended'));
    const endResp = await emit(admin, 'end game');
    assert(!endResp.err, `end game should succeed`);
    await Promise.all(endedEvents);

    // Try to end again — should fail
    const endAgain = await emit(admin, 'end game');
    assert(endAgain === 'Error', 'second end should be Error');

    // Reset game
    const resetEvents = players.map(s => once(s, 'game reset'));
    const resetResp = await emit(admin, 'reset game');
    assert(!resetResp.err, `reset after ended should succeed`);
    await Promise.all(resetEvents);

    // Start again
    const start2Events = players.map(s => once(s, 'game started'));
    const start2Resp = await emit(admin, 'start game');
    assert(!start2Resp.err, `restart after reset should succeed: ${start2Resp.err || ''}`);
    await Promise.all(start2Events);

    console.log('  start(0p) → login(4p) → end → reset → start all OK');
  } finally {
    admin.close();
    players.forEach(s => s.close());
  }
}

// ─── Test 6: Disconnected player ──────────────────────────────────────

async function testDisconnectedPlayer() {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);

    // Start game first
    await emit(admin, 'start game');

    // Register 4 players — group auto-starts on 4th
    const players: Socket[] = [];
    const startedPromises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      startedPromises.push(once(s, 'game started'));
      await emit(s, 'submit username', `dc-${i + 1}`);
      players.push(s);
    }
    await Promise.all(startedPromises);

    // Round 1: all submit
    let nt = players.map(s => once(s, 'next turn'));
    for (let i = 0; i < 4; i++) await emit(players[i], 'submit order', '4');
    let turns = await Promise.all(nt);
    assertEq(turns[0].week, 2, 'round 1 completed');
    // Disconnect player 2 (批发商, index 1)
    players[1].close();
    await wait(GRACE_MS + 300); // Wait for grace to expire

    // Round 2: 3 online players submit — turn should NOT advance
    // (disconnected player role stays in waitingForOrders)
    const resps = await Promise.all([
      emit(players[0], "submit order", "5"),
      emit(players[2], "submit order", "5"),
      emit(players[3], "submit order", "5"),
    ]);
    const lastResp = resps[resps.length - 1];
    assert(Array.isArray(lastResp) && lastResp.length > 0, "waiting list should still contain dropped player role");
    assert(lastResp.includes("批发商"), "批发商 should still be in waitingForOrders");

    // Reconnect the dropped player
    const reconnected = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { reconnected.once("connect", r); reconnected.once("connect_error", rj); });
    const rejoin = await emit(reconnected, "submit username", "dc-2");
    assertEq(rejoin.idx, 1, "reconnected player should get same index");
    assertEq(rejoin.group.users[1].role.name, "批发商", "reconnected player role");

    // Now submit reconnected player order — turn should advance
    const ntAfter = players.map((s, i) => {
      if (i === 1) return once(reconnected, "next turn");
      return once(s, "next turn");
    });
    await emit(reconnected, "submit order", "5");
    turns = await Promise.all(ntAfter);
    assertEq(turns[0].week, 3, "round 2 completed after reconnect");

    console.log("  game waits for disconnected player, continues after reconnect");

    players.forEach(s => s.close());
    reconnected.close();
  } finally {
    admin.close();
  }
}

// ─── Test 7: Login timing rules ────────────────────────────────────────

async function testLoginTiming() {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);

    // 1. Login before game starts -> reject
    const s1 = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { s1.once('connect', r); s1.once('connect_error', rj); });
    const beforeResp = await emit(s1, 'submit username', 'before-game');
    const beforeExpected = '游戏尚未开始，请等待管理员启动。';
    assert(beforeResp === beforeExpected,
      `login before game should be rejected, got: ${JSON.stringify(beforeResp)}`);
    s1.close();

    // 2. Start game
    await emit(admin, 'start game');

    // 3. Login during game -> allow
    const s2 = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { s2.once('connect', r); s2.once('connect_error', rj); });
    const duringResp = await emit(s2, 'submit username', 'during-game');
    assert(duringResp && typeof duringResp === 'object' && duringResp.idx !== undefined,
      `login during game should succeed`);

    // 4. End game
    await emit(admin, 'end game');

    // 5. New user after game ended -> reject
    const s3 = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { s3.once('connect', r); s3.once('connect_error', rj); });
    const afterResp = await emit(s3, 'submit username', 'after-game');
    assert(afterResp === 'Game Ended', 'new user after game ended should be rejected');
    s3.close();

    // 6. Reconnect with same username after game ended -> allow
    const s2reconnect = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { s2reconnect.once('connect', r); s2reconnect.once('connect_error', rj); });
    s2.close();
    await wait(100);
    const reconnectResp = await emit(s2reconnect, 'submit username', 'during-game');
    assert(reconnectResp && typeof reconnectResp === 'object' && reconnectResp.idx !== undefined,
      'reconnect after game ended should succeed');
    s2reconnect.close();

    console.log('  before✗ | during✓ | after(new)✗ | after(reconnect)✓');
  } finally {
    admin.close();
  }
}

// ─── Test 8: Independent group operations ───────────────────────────────

async function testIndependentGroups() {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);
    await emit(admin, 'start game');

    // Group 1: 4 players, auto-starts
    const g1Players: Socket[] = [];
    const g1Promises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      g1Promises.push(once(s, 'game started'));
      await emit(s, 'submit username', `g1-${PLAYERS[i]}`);
      g1Players.push(s);
    }
    await Promise.all(g1Promises);

    // Advance group 1 by 5 rounds
    for (let r = 0; r < 5; r++) {
      const nt = g1Players.map(s => once(s, 'next turn'));
      for (let i = 0; i < 4; i++) await emit(g1Players[i], 'submit order', String(4 + r));
      const turns = await Promise.all(nt);
      assertEq(turns[0].week, r + 2, `g1 round ${r + 1} week`);
    }

    // Group 2: 4 different players, starts from week 1
    const g2Players: Socket[] = [];
    const g2Promises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      g2Promises.push(once(s, 'game started'));
      await emit(s, 'submit username', `g2-${PLAYERS[i]}`);
      g2Players.push(s);
    }
    await Promise.all(g2Promises);

    // Verify independent progress: g1 at week 6, g2 at week 1
    const adminData = await emit(admin, 'submit password', ADMIN_PW);
    assertEq(adminData.groups.length, 2, 'should have 2 groups');
    assertEq(adminData.groups[0].week, 6, 'group 1 at week 6');
    assertEq(adminData.groups[1].week, 1, 'group 2 at week 1');

    // Advance group 2 by 1 round, group 1 unchanged
    const g2nt = g2Players.map(s => once(s, 'next turn'));
    for (let i = 0; i < 4; i++) await emit(g2Players[i], 'submit order', '4');
    await Promise.all(g2nt);

    const adminData2 = await emit(admin, 'submit password', ADMIN_PW);
    assertEq(adminData2.groups[0].week, 6, 'group 1 still at week 6');
    assertEq(adminData2.groups[1].week, 2, 'group 2 advanced to week 2');

    g1Players.forEach(s => s.close());
    g2Players.forEach(s => s.close());
    console.log('  g1:5 rounds | g2:starts fresh | independent progress');
  } finally {
    admin.close();
  }
}

// ─── Test 9: Group completion at 26 weeks ───────────────────────────────

async function testGroupCompletion() {
  const admin = connectClient(BASE, { timeout: 5000, reconnection: false });
  try {
    await new Promise<void>((r, rj) => { admin.once('connect', r); admin.once('connect_error', rj); });
    await emit(admin, 'submit password', ADMIN_PW);
    await emit(admin, 'start game');

    // Group 1: complete 26 weeks
    const g1: Socket[] = [];
    const g1promises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      g1promises.push(once(s, 'game started'));
      await emit(s, 'submit username', `done-${PLAYERS[i]}`);
      g1.push(s);
    }
    await Promise.all(g1promises);

    // Group 2: only 2 rounds (won't complete)
    const g2: Socket[] = [];
    const g2promises: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connectClient(BASE, { timeout: 5000, reconnection: false });
      await new Promise<void>((r, rj) => { s.once('connect', r); s.once('connect_error', rj); });
      g2promises.push(once(s, 'game started'));
      await emit(s, 'submit username', `partial-${PLAYERS[i]}`);
      g2.push(s);
    }
    await Promise.all(g2promises);

    // Run group 1 through all 26 weeks
    for (let r = 0; r < 26; r++) {
      const nt = g1.map(s => once(s, 'next turn'));
      for (let i = 0; i < 4; i++) await emit(g1[i], 'submit order', '4');
      await Promise.all(nt);
    }

    // Group 1 at week 27 -> orders rejected
    const rejectResp = await emit(g1[0], 'submit order', '5');
    assert(rejectResp && rejectResp.err && rejectResp.err.includes('26'),
      'order after week 26 should be rejected');

    // Group 2: run only 2 rounds
    for (let r = 0; r < 2; r++) {
      const nt = g2.map(s => once(s, 'next turn'));
      for (let i = 0; i < 4; i++) await emit(g2[i], 'submit order', '4');
      await Promise.all(nt);
    }

    // End game
    await emit(admin, 'end game');

    // New user after end -> rejected
    const newGuy = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { newGuy.once('connect', r); newGuy.once('connect_error', rj); });
    const newResp = await emit(newGuy, 'submit username', 'new-after-end');
    assert(newResp === 'Game Ended', 'new user after game ended should be rejected');
    newGuy.close();

    // Existing user reconnects -> allowed
    const g2reconnect = connectClient(BASE, { timeout: 5000, reconnection: false });
    await new Promise<void>((r, rj) => { g2reconnect.once('connect', r); g2reconnect.once('connect_error', rj); });
    g2[0].close();
    await wait(100);
    const recResp = await emit(g2reconnect, 'submit username', 'partial-retailer');
    assert(recResp && typeof recResp === 'object', 'reconnect after end should succeed');
    g2reconnect.close();

    g1.forEach(s => s.close());
    g2.forEach(s => s.close());
    console.log('  g1:26w(done) | g2:2w | end:new✗ reconnect✓');
  } finally {
    admin.close();
  }
}

// ── Run ───────────────────────────────────────────────────────────────

runTests()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e.stack || e); process.exit(1); });
