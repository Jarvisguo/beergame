/* ========================================================================
 * Beer Distribution Game — 管理端 (modern vanilla JS)
 * ======================================================================== */

const MAX_WEEKS = 26;

const $ = (sel) => document.querySelector(sel);

// ── Socket ────────────────────────────────────────────────────────────
const socket = io(undefined, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 99999,
  timeout: 45000,
});

// ── State ─────────────────────────────────────────────────────────────
let gameGroup = [];
let adminGameStarted = false;
let adminGameEnded = false;

// Expose for report page
window.gameGroup = gameGroup;

// ── Helpers ───────────────────────────────────────────────────────────
function formatWeek(g) {
  const w = g.week || 0;
  const completed = Math.max(0, Math.min(w - 1, MAX_WEEKS));
  if (w > MAX_WEEKS) return `已完成 ${completed} 轮`;
  return `已完成 ${completed} 轮，当前第 ${w} 周`;
}

function updateAdminStatus() {
  const n = gameGroup.reduce((a, g) => a + g.users.filter(u => u.socketId).length, 0);
  const trendText = { growth: '增长趋势', decline: '下降趋势', mixed: '混合趋势' }[$('#demandTrend').value || 'mixed'];
  if (adminGameStarted) {
    const prefix = adminGameEnded ? '游戏已结束。' : '游戏进行中。';
    $('#adminStatus').textContent = `${prefix} 在线 ${n} 人，客户需求：${trendText}。`;
  } else {
    $('#adminStatus').textContent = `游戏尚未开始。当前 ${n} 名参与者。`;
  }
}

// ── Table ─────────────────────────────────────────────────────────────
function refreshTable(groups, gameStarted) {
  const tbody = $('#adminTbody');
  tbody.innerHTML = '';

  groups.forEach((g, i) => {
    const tr = document.createElement('tr');
    const w = gameStarted ? ` (${formatWeek(g)}，¥${(g.cost || 0).toFixed(0)})` : '';
    let html = `<td>${i + 1}${w}</td>`;

    let totalInv = 0, totalBack = 0;
    for (let j = 0; j < 4; j++) {
      if (g.users[j]) {
        totalInv += g.users[j].inventory || 0;
        totalBack += g.users[j].backlog || 0;
        const disc = g.users[j].socketId ? '' : '（已断开）';
        html += `<td>${g.users[j].name}${disc}</td>`;
      } else {
        html += '<td></td>';
      }
    }

    html += `<td>${totalInv}</td><td>${totalBack}</td>`;
    const waiting = g.waitingForOrders || [];
    html += `<td>${waiting.length ? waiting.join('、') : '-'}</td>`;

    if (!gameStarted) {
      html += `<td><button class="btn btn-sm btn-outline btnRemoveGroup" data-group="${i}">删除</button></td>`;
    } else {
      html += '<td></td>';
    }

    tr.innerHTML = html;
    tbody.appendChild(tr);
  });

  gameGroup = groups;
  window.gameGroup = gameGroup;
  try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch (e) { /* ignore */ }
  updateAdminStatus();
}

// ── Charts ────────────────────────────────────────────────────────────
function drawChart(groupIdx, type) {
  const canvas = $('#chartCanvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  const g = gameGroup[groupIdx];
  if (!g || !g.users || g.users.length === 0) { ctx.clearRect(0, 0, w, h); return; }

  const users = g.users;
  const colors = ['#4a90d9', '#e76f51', '#2a9d8f', '#e9c46a'];

  // Collect data
  const histories = users.map(u => {
    if (type === 'cost') return u.costHistory || [];
    if (type === 'inventory') return (u.inventoryHistory || []).map((inv, i) => inv - (u.backlogHistory[i] || 0));
    if (type === 'orders') return u.orderHistory || [];
    return [];
  });

  const maxLen = Math.max(...histories.map(h => h.length));
  if (maxLen === 0) { ctx.clearRect(0, 0, w, h); return; }

  const allVals = histories.flat();
  const maxVal = Math.max(...allVals, 1);
  const minVal = Math.min(0, ...allVals);

  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const pw = w - pad.left - pad.right;
  const ph = h - pad.top - pad.bottom;
  const range = maxVal - minVal || 1;

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ph / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    const val = maxVal - (range / 4) * i;
    ctx.fillStyle = '#666'; ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(val).toString(), pad.left - 6, y + 4);
  }

  // X-axis labels
  ctx.fillStyle = '#666'; ctx.textAlign = 'center';
  for (let i = 0; i < maxLen; i++) {
    const x = pad.left + (pw / Math.max(maxLen - 1, 1)) * i;
    ctx.fillText((i + 1).toString(), x, h - pad.bottom + 16);
  }

  // Title
  ctx.fillStyle = '#333'; ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  const titles = { cost: '成本 (¥)', inventory: '库存 (单位)', orders: '订单 (单位)' };
  ctx.fillText(titles[type] || '', w / 2, 14);

  // Lines
  histories.forEach((hist, idx) => {
    if (hist.length < 2) return;
    ctx.strokeStyle = colors[idx];
    ctx.lineWidth = 2;
    ctx.beginPath();
    hist.forEach((val, i) => {
      const x = pad.left + (pw / Math.max(hist.length - 1, 1)) * i;
      const y = pad.top + ph - ((val - minVal) / range) * ph;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Legend dot
    const lx = pad.left + 60 * idx + 10;
    ctx.fillStyle = colors[idx];
    ctx.beginPath(); ctx.arc(lx, h - 8, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#333'; ctx.textAlign = 'start';
    ctx.fillText(users[idx].role.name, lx + 8, h - 4);
  });
}

// ── Socket Events ─────────────────────────────────────────────────────
socket.on('update table', (msg) => {
  gameGroup = msg.groups;
  window.gameGroup = gameGroup;
  try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch (e) { /* */ }
  refreshTable(gameGroup, adminGameStarted);
});

socket.on('update group', (msg) => {
  gameGroup[msg.groupNum] = msg.groupData;
  refreshTable(gameGroup, true);
  const g = parseInt($('#chartGroup').value);
  const t = $('#chartType').value;
  if (!isNaN(g)) drawChart(g, t);
});

// ── Admin Login ───────────────────────────────────────────────────────
$('#btnAdmin').addEventListener('click', () => {
  const pw = $('#passwordInput').value;
  socket.emit('submit password', pw, (msg) => {
    if (msg === 'Invalid Password') {
      $('#wrongPass').hidden = false;
    } else {
      $('#adminLogin').hidden = true;
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch (e) { /* */ }
      $('#demandTrend').value = msg.demandTrend || 'mixed';
      $('#groupPanel').hidden = false;

      if (msg.status === 'started') {
        startGameUI(msg.numUsers);
      } else if (msg.status === 'ended') {
        startGameUI(msg.numUsers);
        $('#btnEndGame').disabled = true;
        rankGroups();
      } else {
        adminGameStarted = false;
        adminGameEnded = false;
        refreshTable(gameGroup, false);
      }
    }
  });
});

$('#passwordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnAdmin').click();
});

// ── Game Controls ─────────────────────────────────────────────────────
$('#btnStartGame').addEventListener('click', () => {
  if ($('#btnStartGame').disabled) return;
  $('#gameError').hidden = true;
  const trend = $('#demandTrend').value || 'mixed';
  socket.emit('start game', { demandTrend: trend }, (msg) => {
    if (msg.err) {
      $('#gameError').textContent = '无法开始游戏。' + msg.err;
      $('#gameError').hidden = false;
    } else {
      $('#demandTrend').value = msg.demandTrend || trend;
      $('#groupRank').textContent = '团队 #';
      startGameUI(msg.numUsers);
    }
  });
});

$('#btnEndGame').addEventListener('click', () => {
  if ($('#btnEndGame').disabled) return;
  socket.emit('end game', (msg) => {
    if (msg === 'Error') {
      $('#gameError').textContent = '游戏无法结束。';
      $('#gameError').hidden = false;
    } else {
      adminGameEnded = true;
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      $('#btnEndGame').disabled = true;
      rankGroups();
    }
  });
});

$('#btnResetGame').addEventListener('click', () => {
  if ($('#btnResetGame').disabled) return;
  socket.emit('reset game', (msg) => {
    if (msg === 'Error') {
      $('#gameError').textContent = '游戏无法重置。';
      $('#gameError').hidden = false;
    } else {
      adminGameStarted = false;
      adminGameEnded = false;
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      $('#btnStartGame').disabled = false;
      $('#btnEndGame').disabled = false;
      $('#btnEndGame').hidden = true;
      $('#btnResetGame').hidden = true;
      $('#charts').hidden = true;
      $('#gameSettings').hidden = false;
      $('#groupRank').textContent = '团队 #';
      refreshTable(gameGroup, false);
    }
  });
});

$('#btnReport').addEventListener('click', () => {
  window.open('report.html', '_blank');
});

// Delete group
$('#adminTbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.btnRemoveGroup');
  if (!btn) return;
  const groupIdx = btn.getAttribute('data-group');
  socket.emit('remove group', groupIdx, (msg) => {
    if (msg !== 'Error') {
      gameGroup = msg.groups;
      window.gameGroup = gameGroup;
      refreshTable(gameGroup, false);
    }
  });
});

// Chart controls
$('#chartGroup').addEventListener('change', () => {
  drawChart(parseInt($('#chartGroup').value), $('#chartType').value);
});
$('#chartType').addEventListener('change', () => {
  drawChart(parseInt($('#chartGroup').value), $('#chartType').value);
});

// ── Helpers ───────────────────────────────────────────────────────────
function startGameUI(numUsers) {
  adminGameStarted = true;
  adminGameEnded = false;
  $('#gameSettings').hidden = true;
  $('#btnStartGame').disabled = true;
  $('#btnEndGame').disabled = false;
  $('#btnEndGame').hidden = false;
  $('#btnResetGame').hidden = false;

  // Populate chart group selector
  const sel = $('#chartGroup');
  sel.innerHTML = '';
  gameGroup.forEach((_, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = i + 1;
    sel.appendChild(opt);
  });
  $('#charts').hidden = false;

  refreshTable(gameGroup, true);
  drawChart(0, $('#chartType').value);
}

function rankGroups() {
  adminGameStarted = true;
  adminGameEnded = true;
  $('#groupRank').textContent = '排名';

  let lowestWeek = Infinity;
  gameGroup.forEach(g => { if (g.week < lowestWeek) lowestWeek = g.week; });

  gameGroup.sort((a, b) => {
    const ca = a.costHistory[lowestWeek - 1] || 0;
    const cb = b.costHistory[lowestWeek - 1] || 0;
    return ca - cb;
  });

  refreshTable(gameGroup, true);
}
