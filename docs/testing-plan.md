# Beer Distribution Game Test Plan

## Scope

This plan covers the multiplayer Socket.IO game flow, admin controls, deployment-critical static assets, and reconnect behavior. It is written for local regression testing before pushing to GitHub and for smoke testing after Zeabur deploys.

## Test Matrix

| Area | Scenario | Expected Result |
| --- | --- | --- |
| Static assets | Load `/`, `/admin.html`, `/report.html`, and `/socket.io/socket.io.js` | HTTP 200 for all required assets |
| Admin auth | Login with wrong password | Returns `Invalid Password` |
| Admin auth | Login with `ADMIN_PASSWORD` | Returns admin status, user count, and group data |
| User registration | Register four unique users | One group is created with roles `零售商`, `批发商`, `区域仓库`, `工厂` |
| Duplicate login | Register an already-connected username | Request is rejected |
| Start guard | Start game with fewer than four online users | Admin receives an error |
| Start flow | Start game with four online users | All players receive `game started`; week becomes 1 |
| Player UI state | Player role at game start | Header and board should show the same role for that player |
| Ordering | Four players submit orders | Group advances to the next week and each player receives `next turn` |
| Waiting list | Some players submit orders | Waiting list removes submitted roles and keeps remaining roles |
| Reconnect | A disconnected player rejoins with the same username | Player keeps original group index and role |
| Reset | Admin resets a started game | Game returns to waiting state; users keep seats; costs/inventory reset |
| End | Admin ends a started game | Admin receives final groups and players receive `game ended` |
| Callback robustness | Emit admin/player events without ack callback | Server stays alive |

## Manual Browser Smoke Test

1. Open `/admin.html` and four separate private/incognito player windows.
2. Login players as `test1`, `test2`, `test3`, `test4`.
3. Confirm the lobby table assigns four different roles.
4. Start the game from admin.
5. Confirm each player board title matches the top navbar role.
6. Submit one order from each player.
7. Confirm all players advance to the next week.
8. Disconnect one player window, reopen it, login with the same name, and confirm the same role is restored.
9. Test admin reset and end game controls.

## Automated Regression Command

Run:

```sh
npm test
```

The automated test starts the app on a temporary local port, checks static endpoints, and exercises the core Socket.IO game flow.
