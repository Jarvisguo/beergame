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

        socket.emit('start game', function (msg) {
            if (msg.err) {
                $('#errorText').text('无法开始游戏。' + msg.err);
                $('#gameStartError').show();
            } else {
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

        socket.emit('reset game', function (msg) {
            if (msg == "Error") {
                $('#errorText').text('游戏无法重新开始。');
                $('#gameStartError').show();
            } else {
                adminGameStarted = false;
                adminGameEnded = false;
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
    $('#btnStartGame').hide();
    $('#btnEndGame').show();
    $('#btnResetGame').show();
    if (numUsers == 1) {
        var numParticipants = "1 名参与者。";
    } else {
        var numParticipants = numUsers + ' 名参与者。';
    }

    $('#status').text('游戏已开始，共有 ' + numParticipants);

    refreshTable(gameGroup, numUsers, true);
    showChart();
}

// 按盈利排序团队
function rankGroups(numUsers) {
    adminGameStarted = true;
    adminGameEnded = true;
    $('#groupRank').text("排名");
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
        var week = gameStarted ? " (第 " + groups[i].week + " 周，¥" + parseFloat(groups[i].cost).toFixed(0) + ")" : ""
        $('#grouptable > tbody').append('<tr id=\'group' + i + '\'><td>' + (i + 1) + week + '</td></tr>');
        var userDisconnected = false;
        for (var j = 0; j < 4; j++) {
            if (groups[i].users[j]) {
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

        if (!gameStarted) {
            $('#group' + i).append('<td><button type="button" class="btn btn-danger btn-xs btnRemoveGroup" group="' + i + '"><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></button></td>');
        }

        if (userDisconnected) $('#group' + i).addClass("danger");
    }

    gameGroup = groups;
    window.gameGroup = gameGroup;
                try { sessionStorage.setItem('beerGameGroup', JSON.stringify(gameGroup)); } catch(e) {}

    if (numUsers == 1) {
        var numParticipants = "当前有 1 名参与者。";
    } else {
        var numParticipants = '当前有 ' + numUsers + ' 名参与者。';
    }

    if (gameStarted) {
        var statusPrefix = adminGameEnded ? '游戏已结束。' : '游戏已开始。';
        $('#status').text(statusPrefix + numParticipants);
    } else {
        $('#status').text('游戏尚未开始。' + numParticipants);
    }
}

// 图表详情
function drawChart(group, type) {
    if (!chart) chart = new google.visualization.LineChart(document.getElementById('groupChart'));
    var data = new google.visualization.DataTable();
    data.addColumn('string', 'X');

    var groupToShow = gameGroup[group];

    for (var i = 0; i < gameGroup[group].users.length; i++) {
        data.addColumn('number', gameGroup[group].users[i].role.name);
    }

    for (var i = 1; i < gameGroup[group].week; i++) {
        var dataRow = [i.toString()];
        for (var j = 0; j < gameGroup[group].users.length; j++) {
            var numToPush = 0;
            switch (type) {
                case "Cost":
                    numToPush = gameGroup[group].users[j].costHistory[i];
                    vAxisTitle = "成本 (¥)";
                    break;
                case "Inventory":
                    numToPush = parseInt(gameGroup[group].users[j].inventoryHistory[i]) - parseInt(gameGroup[group].users[j].backlogHistory[i]);
                    vAxisTitle = "库存 (单位)";
                    break;
                case "Orders":
                    numToPush = gameGroup[group].users[j].orderHistory[i];
                    vAxisTitle = "订单 (单位)";
                    break;
                default:
            }

            dataRow.push(numToPush);
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
