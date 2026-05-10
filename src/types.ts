export interface Role {
  name: string;
  upstream: { name: string; orders: number; shipments: number };
  downstream: { name: string; orders: number; shipments: number };
}

export interface GameUser {
  name: string;
  socketId?: string;
  disconnectedAt?: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  cost: number;
  inventory: number;
  backlog: number;
  role: Role;
  inventoryHistory: number[];
  backlogHistory: number[];
  costHistory: number[];
  orderHistory: number[];
}

export interface UserLookup {
  name: string;
  socketId: string;
  group: number;
  index: number;
  disconnectedAt?: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

export interface DemandEntry {
  until: number;
  demand: number;
}

export interface DemandProfile {
  name: string;
  schedule: DemandEntry[];
}

export interface Group {
  week: number;
  cost: number;
  users: GameUser[];
  waitingForOrders: string[];
  demandTrend: string;
  demandProfile: DemandProfile;
  shipping: number[][];
  mailing: number[][];
  costHistory: number[];
  ready: boolean;
}
