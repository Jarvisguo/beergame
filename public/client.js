/* ========================================================================
 * Beer Distribution Game Simulator: client.js (中文版)
 * 啤酒分销游戏模拟器
 * ======================================================================== */

var socket = io(undefined, {
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionAttempts: 99999,
  timeout: 60000
});

var curWeek = 0;
var curUser = null;
var numUsers = 0;
var submittedOrder = false;
var userIdx = 0;
var curGroup;
var gameEnded = false;
var maxWeeks = 26;

function hasCompletedFinalWeek() {
    return curWeek > maxWeeks;
}

var countOptions = {
    useEasing: true,
    useGrouping: true,
    separator: ',',
    decimal: '.',
    prefix: '',
    suffix: ''
};

// 登录
$(document).ready(function () {
    $('#board').hide();
    $('#myModal').modal('show');

    // 登录对话框
    $("#btnLogin").click(function (event) {
        event.preventDefault();
        if ($(this).hasClass("disabled")) return;
        var username = $('#formUsername').val();
        socket.emit('submit username', username, function (msg) {
            console.log(msg);
            if (msg == "Invalid Username") {
                $('#errorText').text('该用户名已被使用！请选择一个不同的用户名。');
                $('#errorDialog').show();
            } else if (msg == "Game Started") {
                $('#errorText').text('游戏已开始，无法加入新用户。');
                $('#errorDialog').show();
            } else {
                userIdx = msg.idx;
                curGroup = msg.group;
                curUser = msg.group.users[userIdx];
                curWeek = msg.group.week;
                numUsers = msg.numUsers;
                gameEnded = msg.gameEnded;

                $('#formUsername').val('');
                $('#errorDialog').hide();
                $('#myModal').modal('hide');
                $('#role').text('您的角色：' + curUser.role.name);
                $('#username').text('已登录：' + curUser.name);

                if (curWeek > 0 && !gameEnded) {
                    nextTurn(numUsers, curWeek, curUser);
                    // 加入游戏时：如果自己已不在等待列表中，说明本轮已提交
                    if (hasCompletedFinalWeek()) {
                        // 达到总轮次上限后不允许下单
                        submittedOrder = true;
                        $("#formOrderAmount").val('已结束');
                        $("#btnOrder").attr("disabled", true);
                        $("#formOrderAmount").attr("disabled", true);
                        $('#waitingOnUsers').html('<span class="label label-danger">⛔ 已完成' + maxWeeks + '周，停止运营</span>').fadeIn('fast');
                    } else if (curGroup.waitingForOrders.indexOf(curUser.role.name) < 0) {
                        submittedOrder = true;
                        $("#formOrderAmount").val(curUser.role.upstream.orders);
                        $("#btnOrder").attr("disabled", true);
                        $("#formOrderAmount").attr("disabled", true);
                        updateWait(curGroup.waitingForOrders);
                    } else {
                        // 自己的角色还在等待列表中，可以提交
                        submittedOrder = false;
                        $('#newOrder').fadeIn('fast');
                        $("#btnOrder").attr("disabled", false);
                        $("#formOrderAmount").attr("disabled", false);
                        $('#waitingOnUsers').fadeOut('fast');
                    }
                    $('#board').show();
                    $('#lobby').hide();
                } else if (gameEnded) {
                    updateStatus();
                    updateTable(true);
                } else {
                    updateStatus();
                    updateTable(false);
                }
            }
        });
    });

    // 提交订单
    $("#btnOrder").click(function (e) {
        e.preventDefault();
        // 只检查HTML disabled属性，不检查CSS class（class可能滞后）
        if (this.disabled) return;
        var orderAmount = $('#formOrderAmount').val();

        var curCost = parseInt($('#cstAmt').text());
        var costCount = new CountUp("cstAmt", curCost, parseFloat(curUser.cost).toFixed(0), 0, 3, countOptions);
        costCount.start();

        socket.emit('submit order', orderAmount, function (msg) {
            submittedOrder = true;
            $('#newOrder').fadeOut("fast");
            $("#btnOrder").attr("disabled", true);
            $("#formOrderAmount").attr("disabled", true);
            // 立即更新本地的 waitingForOrders
            if (msg && curGroup) {
                curGroup.waitingForOrders = msg;
            }
            updateWait(msg);
        });
    });

    // 接收货物
    $("#btnDeliver").click(function () {
        $('#acceptDelivery').fadeOut("fast");
        $('#upstreamShipments').addClass('animated bounceInRight');
        $('#upstreamShipments').one('webkitAnimationEnd mozAnimationEnd MSAnimationEnd oanimationend animationend', function () {
            $('#upstreamShipments').removeClass('animated bounceInRight');
            $('#curInventory').addClass('animated bounce');
            $('#curInventory').one('webkitAnimationEnd mozAnimationEnd MSAnimationEnd oanimationend animationend', function () {
                $('#curInventory').removeClass('animated bounce');
                var curInventory = parseInt($('#inventoryAmt').text());
                var inventoryCount = new CountUp("inventoryAmt", curInventory, curInventory + curUser.role.upstream.shipments, 0, 2, countOptions);
                var shipmentCount = new CountUp("usShpAmt", curUser.role.upstream.shipments, 0, 0, 2, countOptions);
                shipmentCount.start();
                inventoryCount.start(function () {
                    $('#fulfillText').text(curUser.role.downstream.name + ' 正在等待他们的订单。您需要尽可能满足需求！');
                    $('#fulfillOrder').fadeIn("fast");
                });
            });
        });
    });

    // 完成订单
    $("#btnFulfill").click(function () {
        $('#fulfillOrder').fadeOut("fast");
        $('#downstreamOrders').addClass('animated bounceInLeft');
        $('#downstreamOrders').one('webkitAnimationEnd mozAnimationEnd MSAnimationEnd oanimationend animationend', function () {
            $('#downstreamOrders').removeClass('animated bounceInLeft');
            $('#curInventory').addClass('animated bounce');
            $('#curInventory').one('webkitAnimationEnd mozAnimationEnd MSAnimationEnd oanimationend animationend', function () {
                $('#curInventory').removeClass('animated bounce');
                var curInventory = parseInt($('#inventoryAmt').text());
                var inventoryCount = new CountUp("inventoryAmt", curInventory, curUser.inventory, 0, 2, countOptions);

                var curBacklog = parseInt($('#bklgAmt').text());
                var backlogCount = new CountUp("bklgAmt", curBacklog, curUser.backlog, 0, 2, countOptions);
                var shipmentCount = new CountUp("dsShpAmt", 0, curUser.role.downstream.shipments, 0, 2, countOptions);

                var orderCountdown = new CountUp("dsOrdrAmt", curUser.role.downstream.orders, 0, 0, 3, countOptions);

                backlogCount.start();
                inventoryCount.start();
                orderCountdown.start();

                shipmentCount.start(function () {
                    $('#downstreamShipments').addClass('animated bounce');
                    $('#downstreamShipments').one('webkitAnimationEnd mozAnimationEnd MSAnimationEnd oanimationend animationend', function () {
                        $('#downstreamShipments').removeClass('animated bounce');
                        $('#downstreamShipments').addClass('animated bounceOutLeft');
                        $('#downstreamShipments').one('webkitAnimationEnd mozAnimationEnd MSAnimationEnd oanimationend animationend', function () {
                            $('#downstreamShipments').removeClass('animated bounceOutLeft');

                            if (curUser.role.name == "National/Donor") {
                                $('#orderText').text('是时候向生产线下单了。填写下方订单表单来下单。');
                            } else {
                                $('#orderText').text('是时候向 ' + curUser.role.upstream.name + ' 订货了。填写下方订单表单来下单。');
                            }

                            $('#newOrder').fadeIn("fast");
                            $("#btnOrder").attr("disabled", false);
                            $("#formOrderAmount").attr("disabled", false);
                        });
                    });
                });
            });
        });
    });

    // 进入下一轮
    $('#nextTurn').on('hidden.bs.modal', function (e) {
        if (curWeek != 0 && !gameEnded) {
            $('#formOrderAmount').val('');

            var shipmentCount = new CountUp("usShpAmt", 0, curUser.role.upstream.shipments, 0, 3, countOptions);
            shipmentCount.start();

            var orderCount = new CountUp("dsOrdrAmt", 0, curUser.role.downstream.orders, 0, 3, countOptions);
            orderCount.start();

            if (curUser.role.name == "Factory") {
                $('#deliveryText').text('生产线有新货物到达。接受以开始！');
            } else {
                $('#deliveryText').text('您有一个来自 ' + curUser.role.upstream.name + ' 的新货物。接受以开始！');
            }

            $('#acceptDelivery').fadeIn("fast");
        }
    });
});

// 实时更新用户数
socket.on('user joined', function (msg) {
    numUsers = msg.numUsers;
    updateStatus();
});

// 实时更新用户数
socket.on('user left', function (msg) {
    numUsers = msg.numUsers;
    updateStatus();
});

// 被踢出组
socket.on('change group subscription', function (msg) {
    socket.emit('change group', msg);
});

// 被管理员踢出
socket.on('kicked out', function (msg) {
    socket.emit('ack getting kicked');

    resetUser();

    hideGameBoard();

    $('#myModal').modal('show');
});

// 有人加入您的组
socket.on('group member joined', function (msg) {
    curGroup.users[msg.idx] = msg.update;
    $('#grouptable > tbody > tr').each(function (i) {
        if (msg.idx == i) {
            $(this).html('<td>' + (i + 1) + '</td><td>' + (msg.idx == userIdx ? curGroup.users[i].name : '玩家 ' + (i + 1)) + '</td><td>' + msg.update.role.name + '</td>');

            if (msg.update.socketId) {
                $(this).removeClass("danger");
            }
        }
    });
});

// 有人离开了您的组
socket.on('group member left', function (msg) {
    $('#grouptable > tbody > tr').each(function (i) {
        if (msg.idx == i && !msg.update.socketId && msg.idx != userIdx) {
            $(this).html('<td>' + (i + 1) + '</td><td>玩家 ' + (i + 1) + '（已断开）</td><td>' + msg.update.role.name + '</td>');
            $(this).addClass("danger");
        }
    });
});

// 等待其他人提交订单后才能进入下一周
function updateWait(msg) {
    if (msg && submittedOrder) {
        var listOfUsers = "";
        for (var i = 0; i < msg.length; i++) {
            if (i != 0 && i != msg.length - 1 && msg.length > 1) listOfUsers += "、";
            if (i == msg.length - 1 && msg.length > 1) listOfUsers += " 和 ";
            listOfUsers += msg[i];
        }

        $('#waitingText').text('您的订单已提交。正在等待 ' + listOfUsers + ' 提交订单。');
        $('#waitingOnUsers').fadeIn("fast");
    } else {
        $('#waitingOnUsers').fadeOut("fast");
    }
}

// 实时更新表格
function updateTable(showNames) {
    $('#grouptable > tbody > tr').each(function (i) {
        if (curGroup.users[i] && i != userIdx) {
            if (curGroup.users[i].socketId) {
                $(this).removeClass("danger");
                $(this).html('<td>' + (i + 1) + '</td><td>' + (showNames ? curGroup.users[i].name : '玩家 ' + (i + 1)) + '</td><td>' + curGroup.users[i].role.name + '</td>');
            } else {
                if (curGroup.users[i].role.name) {
                    $(this).html('<td>' + (i + 1) + '</td><td>' + (showNames ? curGroup.users[i].name : '玩家 ' + (i + 1)) + '（已断开）</td><td>' + curGroup.users[i].role.name + '</td>');
                    $(this).addClass("danger");
                } else {
                    $(this).html('<td>' + (i + 1) + '</td><td>等待中...</td><td>' + curGroup.users[i].role.name + '</td>');
                    $(this).removeClass("danger");
                }
            }
        }

        if (i == userIdx) {
            $(this).html('<td>' + (i + 1) + '</td><td>' + curGroup.users[i].name + '</td><td>' + curGroup.users[i].role.name + '</td>');
            $(this).addClass("active");
        }
    });
}

// 重置用户状态（游戏重置时使用）
function resetUser() {
    curWeek = 0;
    curUser = null;
    numUsers = 0;
    submittedOrder = false;
    userIdx = 0;
    curGroup = null;
    gameEnded = false;

    $('#grouptable > tbody > tr').each(function (i) {
        $(this).removeClass("danger");
        $(this).html('<td>' + (i + 1) + '</td><td>等待中...</td><td></td>');
    });
}

// 更新状态消息
function updateStatus() {
    if (numUsers == 1) {
        var numParticipants = "当前有 1 名参与者。";
    } else {
        var numParticipants = '当前有 ' + numUsers + ' 名参与者。';
    }

    if (curWeek > 0 && !gameEnded) {
        if (hasCompletedFinalWeek()) {
            $('#participants').text('游戏已完成 ' + maxWeeks + ' 周。' + numParticipants);
        } else {
            $('#participants').text('游戏已开始。您在第 ' + curWeek + ' 周。' + numParticipants);
        }
    } else if (!gameEnded) {
        $('#participants').text('等待游戏开始。' + numParticipants);
    } else {
        $('#participants').text('游戏已结束。您完成于第 ' + curWeek + ' 周。' + numParticipants);
    }
}

function updateBoard() {
    if (!curUser || !curUser.role) return;

    $('#downstreamRole').text(curUser.role.downstream.name);
    $('#upstreamRole').text(curUser.role.upstream.name);
    $('#userRole').text(curUser.role.name + '（您）');

    $('#dsOrdrAmt').text(curUser.role.downstream.orders || 0);
    $('#dsShpAmt').text(curUser.role.downstream.shipments || 0);
    $('#usShpAmt').text(curUser.role.upstream.shipments || 0);
    $('#cstAmt').text((curUser.cost || 0).toFixed(2));
    $('#inventoryAmt').text(curUser.inventory || 0);
    $('#bklgAmt').text(curUser.backlog || 0);

    $("span.upstreamName").text(curUser.role.upstream.name);
    $("span.downstreamName").text(curUser.role.downstream.name);
}

// 下一轮（第几周）逻辑
function nextTurn(users, week, user) {
    curUser = user;
    numUsers = users;
    curWeek = week;

    updateStatus();
    updateAnalytics();  // 更新实时数据分析面板
    updateBoard();

    // nextTurn 更新页面数据（不再弹窗）
    $("span.weekText").text(hasCompletedFinalWeek() ? "已完成 " + maxWeeks + " 周" : "第 " + week + " 周");
}

// 更新实时数据分析面板
function updateAnalytics() {
    // 显示分析面板
    $('#analyticsPanel').show();
    
    // 更新周数
    $('#currentWeek').text(Math.min(curWeek || 0, maxWeeks));
    
    // 更新进度条
    var progress = Math.min(100, ((curWeek || 0) / maxWeeks) * 100);
    $('#weekProgress').css('width', progress + '%');
    
    // 更新成本图表
    if (curUser && curUser.costHistory) {
        var costHtml = '';
        var maxCost = Math.max.apply(null, curUser.costHistory) || 100;
        curUser.costHistory.forEach(function(c, i) {
            var height = (c / maxCost) * 100;
            var color = i < 8 ? '#4a90d9' : (i < 19 ? '#5ba0e0' : (i < 26 ? '#6bb0e7' : '#7cc0ee'));
            costHtml += '<div style="flex:1;height:' + height + '%;background:' + color + ';min-height:2px;border-radius:2px 2px 0 0;" title="第' + (i+1) + '周: ¥' + c.toFixed(0) + '"></div>';
        });
        $('#costChart').html(costHtml);
    }
    
    // 更新订单历史
    if (curUser && curUser.orderHistory) {
        var orderHtml = '';
        var maxOrder = Math.max.apply(null, curUser.orderHistory) || 20;
        curUser.orderHistory.forEach(function(o, i) {
            var height = (o / maxOrder) * 100;
            var color = o <= 12 ? '#2a9d8f' : (o <= 16 ? '#e9c46a' : '#e76f51');
            orderHtml += '<div style="flex:1;height:' + height + '%;background:' + color + ';min-height:2px;border-radius:2px 2px 0 0;" title="第' + (i+1) + '周: ' + o + '箱"></div>';
        });
        $('#orderHistory').html(orderHtml);
    }
    
    // 牛鞭效应指示
    if (curUser) {
        var orders = curUser.orderHistory || [];
        if (orders.length < 2) {
            $('#bullwhipIndicator').html('<span class="label label-default">数据不足</span>');
        } else {
            var mean = orders.reduce(function(a, b) { return a + b; }, 0) / orders.length;
            var variance = orders.reduce(function(a, b) { return a + Math.pow(b - mean, 2); }, 0) / orders.length;
            var stdDev = Math.sqrt(variance);
            var cv = mean > 0 ? stdDev / mean : 0;
            
            if (cv < 0.1) {
                $('#bullwhipIndicator').html('<span class="label label-success">🟢 稳定 (CV:' + (cv*100).toFixed(0) + '%)</span>');
            } else if (cv < 0.3) {
                $('#bullwhipIndicator').html('<span class="label label-warning">🟡 波动 (CV:' + (cv*100).toFixed(0) + '%)</span>');
            } else {
                $('#bullwhipIndicator').html('<span class="label label-danger">🔴 剧烈 (CV:' + (cv*100).toFixed(0) + '%)</span>');
            }
        }
    }
    
    // 供应链状态
    if (curUser) {
        var status = '';
        if (hasCompletedFinalWeek()) {
            status = '<span class="label label-danger">⛔ 已完成' + maxWeeks + '周</span>';
        } else if (curUser.backlog > 20) {
            status = '<span class="label label-danger">⚠️ 严重积压(' + curUser.backlog + ')</span>';
        } else if (curUser.backlog > 5) {
            status = '<span class="label label-warning">⚡ 有积压(' + curUser.backlog + ')</span>';
        } else if (curUser.inventory > 30) {
            status = '<span class="label label-info">📦 高库存(' + curUser.inventory + ')</span>';
        } else {
            status = '<span class="label label-success">✅ 正常</span>';
        }
        $('#supplyChainStatus').html(status);
    }
    
    // 总轮次警告
    if (curWeek >= maxWeeks - 5 && !hasCompletedFinalWeek() && !$('#weekProgress').parent().find('.week-warning').length) {
        $('#weekProgress').parent().append('<small class="week-warning" style="color:#e63946;margin-left:10px;">⚠️ 即将到达' + maxWeeks + '周上限！</small>');
    }
}

// 游戏结束时游戏板消失
function hideGameBoard() {
    $('#board').hide();
    $('#nextTurn').modal('hide');

    $('#waitingOnUsers').hide();
    $('#acceptDelivery').hide();
    $('#fulfillOrder').hide();
    $('#newOrder').hide();
}

// 游戏开始时的UI设置
socket.on('game started', function (msg) {
    curUser = msg.update || curUser;
    curWeek = msg.week;
    numUsers = msg.numUsers;

    // 更新本地的 waitingForOrders（服务器发来的）
    if (msg.waitingForOrders && curGroup) {
        curGroup.waitingForOrders = msg.waitingForOrders;
    }
    // 游戏开始时：玩家需要下第1周订单，直接显示表单不弹窗
    if (curUser && msg.waitingForOrders && msg.waitingForOrders.indexOf(curUser.role.name) < 0) {
        submittedOrder = true;
    } else {
        submittedOrder = false;
    }
    // 直接显示订单表单，不弹窗（第1周无需显示上轮结果）
    updateStatus();
    updateBoard();
    $('#board').show();
    $('#lobby').hide();
    $('#newOrder').fadeIn('fast');
    $("#btnOrder").attr("disabled", false);
    $("#formOrderAmount").attr("disabled", false);
    $("span.weekText").text(hasCompletedFinalWeek() ? "已完成 " + maxWeeks + " 周" : "第 " + msg.week + " 周");
    gameEnded = false;
});

// 游戏重置（回到大厅）
socket.on('game reset', function (msg) {
    gameEnded = false;
    $('#lobby').show();
    curWeek = msg.week;
    numUsers = msg.numUsers;

    hideGameBoard();

    updateTable(false);
    updateStatus();
});

// 游戏结束（回到大厅）
socket.on('game ended', function (msg) {
    gameEnded = true;
    $('#lobby').show();
    numUsers = msg.numUsers;

    hideGameBoard();

    updateTable(true);
});

// 收到组内某人提交订单的消息
socket.on('update order wait', function (msg) {
    updateWait(msg);
});

socket.on('next turn', function (msg) {
    $('#waitingOnUsers').fadeOut("fast");
    if (msg.waitingForOrders && curGroup) {
        curGroup.waitingForOrders = msg.waitingForOrders;
    }
    var myRoleWaiting = curUser && msg.waitingForOrders && msg.waitingForOrders.indexOf(curUser.role.name) >= 0;
    submittedOrder = !myRoleWaiting;
    if (msg.week > maxWeeks) {
        submittedOrder = true;
        $('#newOrder').fadeOut('fast');
        $("#formOrderAmount").val('已结束');
        $("#btnOrder").attr("disabled", true);
        $("#formOrderAmount").attr("disabled", true);
        $('#waitingOnUsers').html('<span class="label label-danger">⛔ 已完成' + maxWeeks + '周，停止运营</span>').fadeIn('fast');
    } else if (!submittedOrder) {
        $('#newOrder').fadeIn('fast');
        $("#btnOrder").attr("disabled", false);
        $("#formOrderAmount").attr("disabled", false);
    } else {
        $('#newOrder').fadeOut('fast');
        $("#btnOrder").attr("disabled", true);
        $("#formOrderAmount").attr("disabled", true);
        $('#waitingOnUsers').fadeIn('fast');
    }
    nextTurn(msg.numUsers, msg.week, msg.update);
});

// 收到组已满（可以开始）通知
socket.on('group ready', function (msg) {
    $('#role').text('您的角色：' + curUser.role.name + ' - 组已满，准备开始！');
});
