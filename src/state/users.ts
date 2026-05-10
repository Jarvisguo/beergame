import type { GameUser, UserLookup, Group } from '../types.js';
import {
  BEER_NAMES,
  STARTING_INVENTORY,
  MAX_WEEKS,
  DEMAND_PROFILES,
  DEFAULT_DEMAND_TREND,
} from '../config.js';
import {
  log,
  groupRoom,
  deepClone,
  makeRole,
  clearDisconnectTimer,
} from '../utils.js';
import { state } from './store.js';

// ---------------------------------------------------------------------------
// registerUser
// ---------------------------------------------------------------------------

/**
 * Assign a socket to a player slot.
 *
 * Priority order (per requirements doc):
 *  1. Known username + already active (has socketId, not disconnected) -> reject
 *  2. Known username + disconnected                                     -> reconnect
 *  3. Any group slot whose socketId is empty (takeover a disconnected slot)
 *  4. Any group slot that is not yet filled (< 4 players, week-agnostic)
 *  5. Create a new group
 */
export function registerUser(
  socketId: string,
  userName: string,
  io: { sockets: { sockets: Map<string, unknown> } },
): { user: UserLookup; isReconnect: boolean } | { error: string } {
  // -- 1 & 2: known username -------------------------------------------------
  if (state.users[userName]) {
    const u = state.users[userName];
    const existingSocket = io.sockets.sockets.get(u.socketId);

    // 1. Already active -> reject (single-role constraint)
    if (u.socketId && !u.disconnectedAt && existingSocket) {
      return { error: 'username already active' };
    }

    // 2. Disconnected -> reconnect
    clearDisconnectTimer(u);
    const g = state.groups[u.group];
    g.users[u.index].socketId = socketId;
    delete g.users[u.index].disconnectedAt;
    delete g.users[u.index].disconnectTimer;
    u.socketId = socketId;
    delete u.disconnectedAt;
    delete u.disconnectTimer;

    log('INFO', `reconnect: ${userName} -> group ${u.group} slot ${u.index}`);
    return { user: u, isReconnect: true };
  }

  // Game must be running for new assignments
  if (!state.gameStarted) return { error: 'game not started' };
  if (state.gameEnded) return { error: 'game already ended' };

  // -- 3. Takeover: find any slot with an empty socketId --------------------
  for (let gi = 0; gi < state.groups.length; gi++) {
    const grp = state.groups[gi];
    if (grp.week > MAX_WEEKS) continue;

    for (let ri = 0; ri < grp.users.length; ri++) {
      const slot = grp.users[ri];
      if (slot && !slot.socketId) {
        return placeUser(socketId, userName, gi, ri, true);
      }
    }
  }

  // -- 4. New slot: any group with fewer than 4 players ---------------------
  for (let gi = 0; gi < state.groups.length; gi++) {
    const grp = state.groups[gi];
    if (grp.week > MAX_WEEKS) continue;
    if (grp.users.length >= 4) continue;

    const taken = [false, false, false, false];
    for (const gu of grp.users) {
      const ri = BEER_NAMES.indexOf(gu.role.name);
      if (ri >= 0) taken[ri] = true;
    }
    for (let ri = 0; ri < 4; ri++) {
      if (!taken[ri]) {
        return placeUser(socketId, userName, gi, ri, false);
      }
    }
  }

  // -- 5. Create a new group ------------------------------------------------
  const newGroupIndex = state.groups.length;
  state.groups.push(makeEmptyGroup());
  return placeUser(socketId, userName, newGroupIndex, 0, false);
}

// ---------------------------------------------------------------------------
// finalizeDisconnect
// ---------------------------------------------------------------------------

/**
 * Called after the reconnect grace period expires.
 * Clears the player's slot and notifies all relevant parties via onEmit.
 */
export function finalizeDisconnect(
  userName: string,
  onEmit: (
    target: 'room' | 'admins',
    event: string,
    data: unknown,
    id?: string,
  ) => void,
): void {
  const user = state.users[userName];
  if (!user || !user.disconnectedAt) return;

  const group = state.groups[user.group];
  if (!group || !group.users[user.index]) return;

  clearDisconnectTimer(user);

  delete group.users[user.index].socketId;
  delete group.users[user.index].disconnectedAt;
  delete group.users[user.index].disconnectTimer;
  delete state.users[userName];

  if (state.numUsers > 0) state.numUsers--;

  onEmit(
    'room',
    'group member left',
    { idx: user.index, update: group.users[user.index] },
    groupRoom(user.group),
  );

  onEmit('admins', 'update table', {
    numUsers: state.numUsers,
    groups: state.groups,
  });

  log('INFO', `finalize disconnect: ${userName} removed from group ${user.group}`);
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

function placeUser(
  socketId: string,
  userName: string,
  groupIndex: number,
  slotIndex: number,
  isTakeover: boolean,
): { user: UserLookup; isReconnect: boolean } {
  const g = state.groups[groupIndex];

  if (isTakeover) {
    // Overwrite the disconnected player's identity, keep game state intact
    g.users[slotIndex].name = userName;
    g.users[slotIndex].socketId = socketId;
    delete g.users[slotIndex].disconnectedAt;
    delete g.users[slotIndex].disconnectTimer;
  } else {
    // Brand-new slot
    const role = deepClone(makeRole(slotIndex));
    const newUser: GameUser = {
      name: userName,
      socketId,
      cost: 0,
      inventory: STARTING_INVENTORY,
      backlog: 0,
      role,
      inventoryHistory: [],
      backlogHistory: [],
      costHistory: [],
      orderHistory: [],
    };
    g.users[slotIndex] = newUser;
  }

  const lu: UserLookup = {
    name: userName,
    socketId,
    group: groupIndex,
    index: slotIndex,
  };
  state.users[userName] = lu;
  state.numUsers++;

  log(
    'INFO',
    `${isTakeover ? 'takeover' : 'new player'}: ${userName} -> group ${groupIndex} slot ${slotIndex}`,
  );

  return { user: lu, isReconnect: false };
}

function makeEmptyGroup(): Group {
  const trend = state.currentDemandTrend;
  const profile = deepClone(
    DEMAND_PROFILES[trend] ?? DEMAND_PROFILES[DEFAULT_DEMAND_TREND],
  );
  return {
    week: 0,
    cost: 0,
    users: [],
    waitingForOrders: [],
    demandTrend: trend,
    demandProfile: profile,
    shipping: [],
    mailing: [],
    costHistory: [],
    ready: false,
  };
}
