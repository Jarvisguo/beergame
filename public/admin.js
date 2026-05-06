/* ========================================================================
 * Beer Distribution Game Simulator: admin.js (中文版)
 * 啤酒分销游戏模拟器 - 管理后台
 * ======================================================================== */

var socket = io(undefined, {
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionAttempts: 99999,
  timeout: 60000
});
var chart;

// Expose gameGroup globally so report.html can access it
window.gameGroup = undefined;
var gameGroup;
var adminGameStarted = false;
var adminGameEnded = false;
var maxWeeks = 26;
var demandTrend = "mixed";

var demandTrendLabels = {
    growth: "增长趋势",
    decline: "下降趋势",
    mixed: "混合趋势"
};

function formatGroupWeek(group) {
    var week = group.week || 0;
    var completedWeeks = Math.max(0, Math.min(week - 1, maxWeeks));
    if (week > maxWeeks) return "已完成 " + completedWeeks + " 轮";
    return "已完成 " + completedWeeks + " 轮，当前第 " + week + " 周";
}

function formatParticipantCount(numUsers) {
    return numUsers == 1 ? "1 名参与者。" : numUsers + " 名参与者。";
}

function updateAdminStatus(numUsers, gameStarted) {
    if (gameStarted) {
        var statusPrefix = adminGameEnded ? '游戏已结束，共有 ' : '游戏已开始，共有 ';
        $('#status').text(statusPrefix + formatParticipantCount(numUsers) + ' 客户需求：' + (demandTrendLabels[demandTrend] || demandTrendLabels.mixed) + '。');
    } else {
        $('#status').text('游戏尚未开始。当前有 ' + numUsers + ' 名参与者。');
    }
}

google.charts.load('current', { packages: ['corechart'] });

// 管理后台
$(document).ready(function () {
    $('#grouppanel').hide();
    $('#myModal').modal('show');
    $('#btnResetGame').hide();
    $('#btnEndGame').hide();
    $('#charts').hide();

    // 登录对话框
    $("#btnAdmin").click(function () {
        var password = $('#formPassword').val();
        socket.emit('submit password', password, function (msg) {
            if (msg == "Invalid Password") {
                $('#wrongPassword').show();
            } else {
                $('#myModal').modal('hide');
                $('#groupRank').text("团队 #");
                gameGroup = msg.groups;
                demandTrend = msg.demandTrend || demandTrend;
                $('#demandTrend').val(demandTrend);
                window.gameGroup = gameGroup;
                try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch(e) {}
                $('#grouppanel').show();

                if (msg.status == "started") {
                    startGame(msg.numUsers);
                } else if (msg.status == "ended") {
                    startGame(msg.numUsers);
                    $('#btnEndGame').hide();
                    rankGroups(msg.numUsers);
                } else {
                    adminGameStarted = false;
                    adminGameEnded = false;
                    refreshTable(gameGroup, msg.numUsers, false);
                }
            }
        });
    });

    // 开始游戏按钮
    $("#btnStartGame").click(function () {
        $('#gameStartError').hide();

        demandTrend = $('#demandTrend').val() || "mixed";
        socket.emit('start game', { demandTrend: demandTrend }, function (msg) {
            if (msg.err) {
                $('#errorText').text('无法开始游戏。' + msg.err);
                $('#gameStartError').show();
            } else {
                demandTrend = msg.demandTrend || demandTrend;
                $('#demandTrend').val(demandTrend);
                $('#groupRank').text("团队 #");
                startGame(msg.numUsers);
            }
        });
    });

    // 重置游戏按钮
    $("#btnResetGame").click(function () {
        $('#btnStartGame').show();
        $('#btnEndGame').hide();
        $('#btnResetGame').hide();
        $('#charts').hide();
        $('#gameSettings').show();

        socket.emit('reset game', function (msg) {
            if (msg == "Error") {
                $('#errorText').text('游戏无法重新开始。');
                $('#gameStartError').show();
            } else {
                adminGameStarted = false;
                adminGameEnded = false;
                demandTrend = msg.demandTrend || "mixed";
                $('#demandTrend').val(demandTrend);
                gameGroup = msg.groups;
                window.gameGroup = gameGroup;
                try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch(e) {}
                $('#groupRank').text("团队 #");
                refreshTable(gameGroup, msg.numUsers, false);
            }
        });
    });

    // 结束游戏按钮
    $("#btnEndGame").click(function () {
        $('#btnEndGame').hide();

        socket.emit('end game', function (msg) {
            if (msg == "Error") {
                $('#errorText').text('游戏无法结束。');
                $('#gameStartError').show();
            } else {
                adminGameEnded = true;
                gameGroup = msg.groups;
                window.gameGroup = gameGroup;
                try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch(e) {}

                rankGroups(msg.numUsers);
            }
        });
    });

    // 删除团队（人数不足时）
    $(document).on('click', '.btnRemoveGroup', function () {
        socket.emit('remove group', $(this).attr("group"), function (msg) {
            if (msg == "Error") {
                $('#errorText').text('无法删除该团队。');
                $('#gameStartError').show();
            } else {
                gameGroup = msg.groups;
                window.gameGroup = gameGroup;
                try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch(e) {}
                refreshTable(gameGroup, msg.numUsers, false);
            }
        });
    });

    // 图表命令
    $("#chartGroup").change(function () {
        var selectedGroup = $("#chartGroup").val();
        var selectedType = $("#chartType").val();
        drawChart(selectedGroup, selectedType);
    });

    $("#chartType").change(function () {
        var selectedGroup = $("#chartGroup").val();
        var selectedType = $("#chartType").val();
        drawChart(selectedGroup, selectedType);
    });
});

// 有人加入服务器时触发
socket.on('update table', function (msg) {
    gameGroup = msg.groups;
                window.gameGroup = gameGroup;
                try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch(e) {}
    refreshTable(gameGroup, msg.numUsers, adminGameStarted);
});

// 某个团队完成一周时触发
socket.on('update group', function (msg) {
    gameGroup[msg.groupNum] = msg.groupData;

    refreshTable(gameGroup, msg.numUsers, true);

    var selectedGroup = $("#chartGroup").val();
    var selectedType = $("#chartType").val();
    drawChart(selectedGroup, selectedType);
});

// 游戏开始时改变UI
function startGame(numUsers) {
    adminGameStarted = true;
    adminGameEnded = false;
    $('#gameSettings').hide();
    $('#btnStartGame').hide();
    $('#btnEndGame').show();
    $('#btnResetGame').show();
    refreshTable(gameGroup, numUsers, true);
    showChart();
}

// 按盈利排序团队
function rankGroups(numUsers) {
    adminGameStarted = true;
    adminGameEnded = true;
    $('#groupRank').text("排名");
    $('#gameSettings').hide();
    var lowestWeek = gameGroup[gameGroup.length - 1].week;
    for (var i = 0; i < gameGroup.length; i++) {
        if (gameGroup[i].week < lowestWeek) lowestWeek = gameGroup[i].week;
        console.log(gameGroup[i].costHistory);
    }

    gameGroup.sort(function (a, b) {
        console.log(a.costHistory[lowestWeek - 1] + " vs " + b.costHistory[lowestWeek - 1]);
        return a.costHistory[lowestWeek - 1] - b.costHistory[lowestWeek - 1];
    });

    refreshTable(gameGroup, numUsers, true);
}

// 显示图表
function showChart() {
    $("#chartGroup").empty(); // 移除旧选项

    for (var i = 0; i < gameGroup.length; i++) {
        $("#chartGroup").append($("<option></option>").attr("value", i).text(i + 1));
    }

    $('#charts').show();

    var selectedGroup = $("#chartGroup").val();
    var selectedType = $("#chartType").val();
    drawChart(selectedGroup, selectedType);
}

// 实时更新用户表格
function refreshTable(groups, numUsers, gameStarted) {
    $('#grouptable > tbody').html("");
    for (var i = 0; i < groups.length; i++) {
        var week = gameStarted ? " (" + formatGroupWeek(groups[i]) + "，¥" + parseFloat(groups[i].cost || 0).toFixed(0) + ")" : ""
        $('#grouptable > tbody').append('<tr id=\'group' + i + '\'><td>' + (i + 1) + week + '</td></tr>');
        var userDisconnected = false;
        var totalInventory = 0;
        var totalBacklog = 0;
        for (var j = 0; j < 4; j++) {
            if (groups[i].users[j]) {
                totalInventory += groups[i].users[j].inventory || 0;
                totalBacklog += groups[i].users[j].backlog || 0;
                if (groups[i].users[j].socketId) {
                    var userCell = '<td>' + groups[i].users[j].name + '</td>';
                } else {
                    userDisconnected = true;
                    var userCell = '<td>' + groups[i].users[j].name + '（已断开）</td>';
                }
            } else {
                var userCell = '<td></td>';
            }
            $('#group' + i).append(userCell);
        }

        var waitingForOrders = groups[i].waitingForOrders || [];
        $('#group' + i).append('<td>' + totalInventory + '</td>');
        $('#group' + i).append('<td>' + totalBacklog + '</td>');
        $('#group' + i).append('<td>' + (waitingForOrders.length ? waitingForOrders.join('、') : '-') + '</td>');

        if (!gameStarted) {
            $('#group' + i).append('<td><button type="button" class="btn btn-danger btn-xs btnRemoveGroup" group="' + i + '"><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></button></td>');
        } else {
            $('#group' + i).append('<td></td>');
        }

        if (userDisconnected) $('#group' + i).addClass("danger");
    }

    gameGroup = groups;
    window.gameGroup = gameGroup;
                try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch(e) {}

    updateAdminStatus(numUsers, gameStarted);
}

// 图表详情
function drawChart(group, type) {
    if (!chart) chart = new google.visualization.LineChart(document.getElementById('groupChart'));
    var data = new google.visualization.DataTable();
    data.addColumn('string', 'X');

    var groupToShow = gameGroup[group];
    if (!groupToShow || !groupToShow.users || groupToShow.users.length == 0) return;

    for (var i = 0; i < groupToShow.users.length; i++) {
        data.addColumn('number', groupToShow.users[i].role.name);
    }

    var maxRows = 0;
    for (var j = 0; j < groupToShow.users.length; j++) {
        var user = groupToShow.users[j];
        var historyLength = 0;
        if (type == "Cost") historyLength = (user.costHistory || []).length;
        if (type == "Inventory") historyLength = Math.min((user.inventoryHistory || []).length, (user.backlogHistory || []).length);
        if (type == "Orders") historyLength = (user.orderHistory || []).length;
        if (historyLength > maxRows) maxRows = historyLength;
    }

    for (var i = 0; i < maxRows; i++) {
        var dataRow = [(i + 1).toString()];
        for (var j = 0; j < groupToShow.users.length; j++) {
            var numToPush = 0;
            var user = groupToShow.users[j];
            switch (type) {
                case "Cost":
                    numToPush = (user.costHistory || [])[i];
                    vAxisTitle = "成本 (¥)";
                    break;
                case "Inventory":
                    var inventory = (user.inventoryHistory || [])[i];
                    var backlog = (user.backlogHistory || [])[i];
                    numToPush = (inventory === undefined || backlog === undefined) ? undefined : parseInt(inventory) - parseInt(backlog);
                    vAxisTitle = "库存 (单位)";
                    break;
                case "Orders":
                    numToPush = (user.orderHistory || [])[i];
                    vAxisTitle = "订单 (单位)";
                    break;
                default:
            }

            dataRow.push(numToPush === undefined || isNaN(numToPush) ? null : numToPush);
        }
        data.addRows([dataRow]);
    }

    var vAxisTitle = "";
    var chartTitle = "第 " + parseInt(parseInt(group) + 1) + " 组";
    switch (type) {
        case "Cost":
            vAxisTitle = "成本 (¥)";
            break;
        case "Inventory":
            vAxisTitle = "库存 (单位)";
            break;
        case "Orders":
            vAxisTitle = "订单 (单位)";
            break;
        default:
    }

    var options = {
        hAxis: {
            title: '第几周'
        },
        vAxis: {
            title: vAxisTitle
        },
        series: {
            1: { curveType: 'function' }
        },
        'legend': 'bottom',
        'title': chartTitle,
        'width': 675,
        'height': 250
    };

    chart.draw(data, options);
}
