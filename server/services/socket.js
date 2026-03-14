import { Server } from 'socket.io';
import { logger } from '../utils/logger.js';

let io = null;

export function initSocket(server) {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
  });
  
  io.on('connection', (socket) => {
    // We'll move the connection logic here later
    logger.info(`Socket connected: ${socket.id}`);
    
    socket.on('join_session', (data) => {
      const sessionId = (data && typeof data === 'object') ? data.sessionId : data;
      if (sessionId) {
        logger.info(`Socket ${socket.id} joining room session:${sessionId}`);
        socket.join(getRoom(sessionId));
      }
    });
  });

  return io;
}

export function getIO() {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
}

export function getRoom(sessionId) {
  return `session:${sessionId}`;
}

