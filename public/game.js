/* ========================================================================
 * Beer Distribution Game — 玩家端 (modern vanilla JS)
 * ======================================================================== */

const MAX_WEEKS = 26;

// ── DOM refs ──────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

// ── Socket ────────────────────────────────────────────────────────────
const socket = io(undefined, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  reconnectionAttempts: Infinity,
  timeout: 45000,
});

// ── State ─────────────────────────────────────────────────────────────
let curWeek = 0;
let curUser = null;
let numUsers = 0;
let userIdx = 0;
let curGroup = null;
let gameEnded = false;
let myRoleName = '';
let submittedOrder = false;

// ── Connection ────────────────────────────────────────────────────────
function setConn(state) {
  const bar = $('#connBar');
  bar.className = `conn-bar conn-${state}`;
  const map = { online: '🟢 在线', reconnecting: '🟡 重连中...', offline: '🔴 已断开' };
  bar.textContent = map[state] || state;
}

function showToast(msg, dur = 2500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.hidden = true; }, dur);
}

socket.on('connect', () => setConn('online'));
socket.on('reconnect', () => { setConn('online'); showToast('已恢复连接'); });
socket.on('reconnecting', () => setConn('reconnecting'));
socket.on('disconnect', () => setConn('offline'));
socket.on('reconnect_failed', () => setConn('offline'));

// Page Visibility: detect screen-on after phone lock
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) {
    socket.connect();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────
function hasCompleted() { return curWeek > MAX_WEEKS; }

function calcBullwhip(orderHistory) {
  if (!orderHistory || orderHistory.length < 2) return null;
  const mean = orderHistory.reduce((a, b) => a + b, 0) / orderHistory.length;
  const variance = orderHistory.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / orderHistory.length;
  const cv = Math.sqrt(variance) / (mean || 1);
  const cls = cv < 0.1 ? 'tag-green' : cv < 0.3 ? 'tag-yellow' : 'tag-red';
  const label = cv < 0.1 ? '稳定' : cv < 0.3 ? '波动' : '剧烈';
  return { cv, cls, label };
}

function animateNum(el, from, to, dec = 0) {
  const start = performance.now();
  const dur = 800;
  if (el._raf) cancelAnimationFrame(el._raf);
  function tick(now) {
    const p = Math.min(1, (now - start) / dur);
    const ease = 1 - Math.pow(1 - p, 3);
    const val = from + (to - from) * ease;
    el.textContent = dec === 0 ? Math.round(val) : val.toFixed(dec);
    if (p < 1) { el._raf = requestAnimationFrame(tick); }
  }
  el._raf = requestAnimationFrame(tick);
}

// ── Board ─────────────────────────────────────────────────────────────
function updateBoard() {
  if (!curUser || !curUser.role) return;
  $('#downstreamRole').textContent = curUser.role.downstream.name;
  $('#upstreamRole').textContent = curUser.role.upstream.name;
  $('#userRoleName').textContent = curUser.role.name + '（您）';
  $('#dsOrdrAmt').textContent = curUser.role.downstream.orders || 0;
  $('#dsShpAmt').textContent = curUser.role.downstream.shipments || 0;
  $('#usShpAmt').textContent = curUser.role.upstream.shipments || 0;
  $('#cstAmt').textContent = (curUser.cost || 0).toFixed(0);
  $('#inventoryAmt').textContent = curUser.inventory || 0;
  $('#bklgAmt').textContent = curUser.backlog || 0;
}

// ── Status ────────────────────────────────────────────────────────────
function updateStatus() {
  let txt;
  const n = numUsers === 1 ? '当前有 1 名参与者。' : `当前有 ${numUsers} 名参与者。`;
  if (curWeek > 0 && !gameEnded) {
    if (hasCompleted()) {
      txt = `游戏已完成 ${MAX_WEEKS} 周。${n}`;
    } else {
      txt = `游戏进行中。您在第 ${curWeek} 周。${n}`;
    }
  } else if (!gameEnded) {
    txt = `等待游戏开始。${n}`;
  } else {
    txt = `游戏已结束。您完成于第 ${curWeek} 周。${n}`;
  }
  $('#participants').textContent = txt;
}

// ── Analytics ─────────────────────────────────────────────────────────
function updateAnalytics() {
  $('#analytics').hidden = false;

  const w = Math.min(curWeek || 0, MAX_WEEKS);
  $('#weekLabel').textContent = `${w} / 26`;
  $('#weekProgress').style.width = `${Math.min(100, (w / MAX_WEEKS) * 100)}%`;

  // Cost chart
  if (curUser && curUser.costHistory) {
    const costs = curUser.costHistory;
    const maxC = Math.max(...costs, 1);
    const html = costs.map((c, i) => {
      const h = (c / maxC) * 100;
      const shade = Math.round(180 - (h / 100) * 80);
      return `<div title="第${i + 1}周: ¥${c.toFixed(0)}" style="height:${h}%;background:hsl(${210 - (i * 2)},${50}%,${shade > 100 ? 100 : shade}%);flex:1;min-height:2px;border-radius:2px 2px 0 0"></div>`;
    }).join('');
    $('#costChart').innerHTML = html;
  }

  // Order history
  if (curUser && curUser.orderHistory) {
    const orders = curUser.orderHistory;
    const maxO = Math.max(...orders, 1);
    const html = orders.map((o, i) => {
      const h = (o / maxO) * 100;
      const color = o <= 12 ? 'hsl(160,50%,40%)' : o <= 16 ? 'hsl(40,70%,50%)' : 'hsl(10,70%,50%)';
      return `<div title="第${i + 1}周: ${o}箱" style="height:${h}%;background:${color};flex:1;min-height:2px;border-radius:2px 2px 0 0"></div>`;
    }).join('');
    $('#orderHist').innerHTML = html;
  }

  // Bullwhip
  if (curUser && curUser.orderHistory) {
    const bw = calcBullwhip(curUser.orderHistory);
    if (!bw) {
      $('#bullwhip').innerHTML = '<span class="tag tag-gray">数据不足</span>';
    } else {
      $('#bullwhip').innerHTML = `<span class="tag ${bw.cls}">${bw.label} (CV:${(bw.cv * 100).toFixed(0)}%)</span>`;
    }
  }

  // Supply chain status
  if (curUser) {
    let s;
    if (hasCompleted()) s = '<span class="tag tag-red">已完成</span>';
    else if (curUser.backlog > 20) s = `<span class="tag tag-red">严重积压(${curUser.backlog})</span>`;
    else if (curUser.backlog > 5) s = `<span class="tag tag-yellow">有积压(${curUser.backlog})</span>`;
    else if (curUser.inventory > 30) s = `<span class="tag tag-blue">高库存(${curUser.inventory})</span>`;
    else s = '<span class="tag tag-green">正常</span>';
    $('#supplyStatus').innerHTML = s;
  }
}

// ── Waiting ───────────────────────────────────────────────────────────
function updateWait(list) {
  if (list && list.length && submittedOrder) {
    const names = list.join('、');
    $('#waitingText').innerHTML = `您的订单已提交。等待 <strong>${names}</strong> 提交。`;
    $('#waitingFlow').hidden = false;
  } else if (!list || list.length === 0) {
    $('#waitingFlow').hidden = true;
  }
}

// ── Group table ───────────────────────────────────────────────────────
function updateGroupTable() {
  if (!curGroup) return;
  const rows = $('#groupTbody').querySelectorAll('tr');
  rows.forEach((tr, i) => {
    if (!curGroup.users[i]) return;
    const u = curGroup.users[i];
    const bw = calcBullwhip(u.orderHistory);
    const bwCell = bw
      ? `<span class="tag ${bw.cls}">${bw.label} (${(bw.cv * 100).toFixed(0)}%)</span>`
      : '<span class="tag tag-gray">—</span>';
    if (i === userIdx) {
      tr.innerHTML = `<td>${i + 1}</td><td>${u.name}</td><td>${u.role.name}</td><td>${bwCell}</td>`;
      tr.className = 'active';
    } else if (u.socketId) {
      tr.innerHTML = `<td>${i + 1}</td><td>${curWeek > 0 ? u.name : '玩家 ' + (i + 1)}</td><td>${u.role.name}</td><td>${bwCell}</td>`;
      tr.className = '';
    } else {
      tr.innerHTML = `<td>${i + 1}</td><td>${u.name ? u.name : '玩家 ' + (i + 1)}（已断开）</td><td>${u.role.name || ''}</td><td>${bwCell}</td>`;
      tr.className = 'warn';
    }
  });
}

// ── Next turn ─────────────────────────────────────────────────────────
function nextTurn(users, week, user) {
  curUser = user; numUsers = users; curWeek = week;
  updateStatus(); updateAnalytics(); updateBoard();
  $('#weekNum').textContent = hasCompleted() ? `已完成 ${MAX_WEEKS} 周` : `第 ${week} 周`;
  $('#weekInfo').hidden = false;
  updateGroupTable();
}

function resetUI() {
  curWeek = 0; curUser = null; numUsers = 0; userIdx = 0;
  curGroup = null; gameEnded = false; submittedOrder = false;

  $('#flowArea').querySelectorAll('.flow-card').forEach(el => el.hidden = true);
  $('#board').hidden = true;
  $('#analytics').hidden = true;
  $('#weekInfo').hidden = true;
  $('#userRole').textContent = '';
  $('#username').textContent = '';
  $('#mainApp').hidden = true;
  $('#loginModal').hidden = false;

  const rows = $('#groupTbody').querySelectorAll('tr');
  rows.forEach((tr, i) => {
    tr.innerHTML = `<td>${i + 1}</td><td>等待中...</td><td></td><td>—</td>`;
    tr.className = '';
  });
}

// ── Socket Events ─────────────────────────────────────────────────────

socket.on('user joined', (msg) => { numUsers = msg.numUsers; updateStatus(); });
socket.on('user left', (msg) => { numUsers = msg.numUsers; updateStatus(); });

socket.on('change group subscription', (msg) => {
  socket.emit('change group', msg);
});

socket.on('kicked out', () => {
  socket.emit('ack getting kicked');
  resetUI();
});

socket.on('group member joined', (msg) => {
  if (!curGroup) return;
  curGroup.users[msg.idx] = msg.update;
  updateGroupTable();
});

socket.on('group member left', (msg) => {
  if (!curGroup) return;
  updateGroupTable();
});

socket.on('game started', (msg) => {
  curWeek = msg.week; numUsers = msg.numUsers; gameEnded = false;
  curGroup = curGroup || {};
  curGroup.waitingForOrders = msg.waitingForOrders || [];
  if (msg.users) curGroup.users = msg.users;

  curUser = curGroup.users && curGroup.users[userIdx] ? curGroup.users[userIdx] : curUser;
  myRoleName = curUser ? curUser.role.name : '';

  submittedOrder = curGroup.waitingForOrders.indexOf(myRoleName) === -1;

  updateStatus(); updateBoard();
  $('#board').hidden = false;
  $('#lobby').hidden = true;
  $('#weekInfo').hidden = false;
  $('#weekNum').textContent = `第 ${msg.week} 周`;

  // Show order form if my role is waiting
  if (submittedOrder) {
    $('#orderFlow').hidden = true;
    $('#btnOrder').disabled = true;
    $('#orderInput').disabled = true;
  } else {
    $('#orderFlow').hidden = false;
    $('#btnOrder').disabled = false;
    $('#orderInput').disabled = false;
    $('#orderInput').value = '';
  }
  $('#deliveryFlow').hidden = true;
  $('#fulfillFlow').hidden = true;
  $('#waitingFlow').hidden = submittedOrder;
});

socket.on('next turn', (msg) => {
  if (msg.waitingForOrders && curGroup) {
    curGroup.waitingForOrders = msg.waitingForOrders;
  }

  myRoleName = curUser ? curUser.role.name : '';
  submittedOrder = !(msg.waitingForOrders && msg.waitingForOrders.indexOf(myRoleName) >= 0);

  if (msg.week > MAX_WEEKS) {
    submittedOrder = true;
    $('#orderFlow').hidden = true;
    $('#btnOrder').disabled = true;
    $('#orderInput').disabled = true;
    $('#orderInput').value = '已结束';
    $('#waitingText').innerHTML = `已完成 ${MAX_WEEKS} 周，停止运营`;
    $('#waitingFlow').hidden = false;
  } else if (submittedOrder) {
    $('#orderFlow').hidden = true;
    $('#btnOrder').disabled = true;
    $('#orderInput').disabled = true;
    updateWait(msg.waitingForOrders);
  }

  // Trigger turn flow animations
  if (curUser) {
    const prevInventory = parseInt($('#inventoryAmt').textContent) || 0;
    const newUser = msg.update;
    const upstreamDelivery = newUser.role.upstream.shipments;
    const prevCost = parseFloat($('#cstAmt').textContent) || 0;

    // Step 1: Delivery
    $('#btnDeliver').disabled = false;
    $('#btnFulfill').disabled = false;
    $('#deliveryFlow').hidden = false;
    if (curUser.role.name === '工厂') {
      $('#deliveryText').innerHTML = '生产线有新货物到达。';
    } else {
      $('#deliveryText').innerHTML = `来自 <strong>${curUser.role.upstream.name}</strong> 的新货物到达。`;
    }
    animateNum($('#usShpAmt'), 0, upstreamDelivery);
    animateNum($('#inventoryAmt'), prevInventory, prevInventory + upstreamDelivery);

    // Step 2: Fulfill
    $('#fulfillFlow').hidden = false;
    $('#fulfillText').innerHTML = `<strong>${curUser.role.downstream.name}</strong> 正在等待订单。`;
    animateNum($('#dsOrdrAmt'), newUser.role.downstream.orders, 0);
    animateNum($('#dsShpAmt'), 0, newUser.role.downstream.shipments);
    animateNum($('#inventoryAmt'), prevInventory + upstreamDelivery, newUser.inventory);
    animateNum($('#bklgAmt'), curUser.backlog, newUser.backlog);

    // Cost animation
    animateNum($('#cstAmt'), prevCost, newUser.cost, 0);
  }

  nextTurn(msg.numUsers, msg.week, msg.update);
});

socket.on('game reset', () => {
  resetUI();
});

socket.on('game ended', (msg) => {
  gameEnded = true;
  numUsers = msg.numUsers;
  $('#lobby').hidden = false;
  $('#board').hidden = true;
  $('#analytics').hidden = false;
  $('#flowArea').querySelectorAll('.flow-card').forEach(el => el.hidden = true);
  updateGroupTable();
  updateStatus();
});

socket.on('update order wait', (list) => {
  if (curGroup) curGroup.waitingForOrders = list;
  updateWait(list);
});

socket.on('group ready', () => {
  showToast('队伍已满员，等待管理员开始游戏', 4000);
});

socket.on('game can login', () => {
  if (!curUser && !$('#loginModal').hidden) {
    $('#loginErr').hidden = true;
    showToast('游戏已开始，请输入用户名登录', 4000);
  }
});

socket.on('player rejoined', (msg) => {
  if (!curGroup) return;
  curGroup.users[msg.idx] = msg.update;
  updateGroupTable();
  showToast(`${msg.update.name} 已重新上线`, 3000);
});

// ── UI handlers ───────────────────────────────────────────────────────

// ── Cached username ────────────────────────────────────────────────────
const cachedName = localStorage.getItem("bdg_username");
if (cachedName) {
  $("#usernameInput").value = cachedName;
}


$('#btnLogin').addEventListener('click', (e) => {
  e.preventDefault();
  if ($('#btnLogin').classList.contains('disabled')) return;
  const name = $('#usernameInput').value.trim();
  if (!name) return;

  $('#btnLogin').classList.add('disabled');
  socket.emit('submit username', name, (msg) => {
    $('#btnLogin').classList.remove('disabled');
    if (msg === '游戏尚未开始，请等待管理员启动。') {
      $('#loginErr').textContent = '游戏尚未开始，请等待管理员启动。';
      $('#loginErr').hidden = false;
    } else if (msg === 'Game Started') {
      $('#loginErr').textContent = '所有小组已满员，无法加入。';
      $('#loginErr').hidden = false;
    } else if (msg === 'Game Ended') {
      $('#loginErr').textContent = '游戏已结束。';
      $('#loginErr').hidden = false;
    } else if (msg && msg.err) {
      $('#loginErr').hidden = false;
    } else {
      userIdx = msg.idx;
      curGroup = msg.group;
      curUser = msg.group.users[userIdx];
      curWeek = msg.group.week;
      numUsers = msg.numUsers;
      gameEnded = msg.gameEnded;

      $('#loginErr').hidden = true;
      $('#loginModal').hidden = true;
      $('#mainApp').hidden = false;
      $('#userRole').textContent = '您的角色：' + curUser.role.name;
      $('#username').textContent = '已登录：' + curUser.name;
      updateBoard();

      if (msg.reconnected) {
        showToast('欢迎回来，已恢复游戏状态', 3000);
      }

      localStorage.setItem("bdg_username", curUser.name);

      myRoleName = curUser.role.name;

      if (curWeek > 0 && !gameEnded) {
        nextTurn(numUsers, curWeek, curUser);
        if (hasCompleted()) {
          submittedOrder = true;
          $('#orderInput').value = '已结束';
          $('#btnOrder').disabled = true;
          $('#orderInput').disabled = true;
          $('#waitingText').innerHTML = `已完成 ${MAX_WEEKS} 周，停止运营`;
          $('#waitingFlow').hidden = false;
        } else if (curGroup.waitingForOrders.indexOf(myRoleName) === -1) {
          submittedOrder = true;
          $('#btnOrder').disabled = true;
          $('#orderInput').disabled = true;
          $('#orderInput').value = curUser.role.upstream.orders;
          updateWait(curGroup.waitingForOrders);
        } else {
          submittedOrder = false;
          $('#btnOrder').disabled = false;
          $('#orderInput').disabled = false;
          $('#orderFlow').hidden = false;
        }
        $('#board').hidden = false;
        $('#lobby').hidden = true;
      } else if (gameEnded) {
        updateStatus();
        updateGroupTable();
      } else {
        // week=0: waiting for group to fill up, hide all operation cards
        $('#deliveryFlow').hidden = true;
        $('#fulfillFlow').hidden = true;
        $('#orderFlow').hidden = true;
        $('#waitingFlow').hidden = true;
        $('#board').hidden = true;
        $('#lobby').hidden = false;
        updateStatus();
        updateGroupTable();
      }
    }
  });
});

$('#btnOrder').addEventListener('click', (e) => {
  e.preventDefault();
  if ($('#btnOrder').disabled) return;
  const val = $('#orderInput').value.trim();
  if (!/^\d+$/.test(val)) {
    showToast('请输入有效的非负整数订单数量。');
    return;
  }

  const amount = parseInt(val, 10);
  socket.emit('submit order', val, (resp) => {
    if (resp && resp.err) {
      showToast(resp.err, 3000);
      return;
    }
    submittedOrder = true;
    $('#btnOrder').disabled = true;
    $('#orderInput').disabled = true;
    $('#orderFlow').hidden = true;
    if (curGroup && resp) {
      curGroup.waitingForOrders = resp;
    }
  });
});

$('#btnDeliver').addEventListener('click', () => {
  if ($('#btnDeliver').disabled) return;
  $('#btnDeliver').disabled = true;
  $('#deliveryFlow').hidden = true;
  if (curUser && curUser.role) {
    showToast(`已接收来自 ${curUser.role.upstream.name} 的 ${curUser.role.upstream.shipments} 箱货物`);
  }
});

$('#btnFulfill').addEventListener('click', () => {
  if ($('#btnFulfill').disabled) return;
  $('#btnFulfill').disabled = true;
  $('#fulfillFlow').hidden = true;
  if (curUser && curUser.role) {
    const shipped = curUser.role.downstream.shipments;
    const backlog = curUser.backlog;
    const msg = backlog > 0
      ? `已向 ${curUser.role.downstream.name} 发货 ${shipped} 箱，仍有 ${backlog} 箱积压`
      : `已向 ${curUser.role.downstream.name} 发货 ${shipped} 箱 ✓`;
    showToast(msg);
    $('#orderText').innerHTML = `现在向 <strong>${curUser.role.upstream.name}</strong> 订货：`;
  }
  $('#orderFlow').hidden = false;
  $('#btnOrder').disabled = false;
  $('#orderInput').disabled = false;
  $('#orderInput').value = '';
  $('#orderInput').focus();
});

// Enter key to submit login
$('#usernameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnLogin').click();
});
$('#orderInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnOrder').click();
});

// Bullwhip info modal
$('#btnBullwhipInfo').addEventListener('click', () => {
  $('#bullwhipModal').hidden = false;
});
$('#btnBullwhipClose').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#bullwhipModal').hidden = true;
});
$('#bullwhipModal').addEventListener('click', (e) => {
  if (e.target === $('#bullwhipModal')) $('#bullwhipModal').hidden = true;
});
