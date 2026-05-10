import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PORT } from './config.js';
import { log } from './utils.js';
import { registerPlayerHandlers } from './socket/player.js';
import { registerAdminHandlers } from './socket/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const http = createServer(app);
const io = new Server(http, {
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
});

app.use(express.static(resolve(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res: import('http').ServerResponse) => res.setHeader('Cache-Control', 'no-store'),
}));

io.on('connection', (socket) => {
  registerPlayerHandlers(io, socket);
  registerAdminHandlers(io, socket);
});

http.listen(PORT, () => {
  log('INFO', `Beer Distribution Game Simulator v2.0 — http://0.0.0.0:${PORT}`);
});
