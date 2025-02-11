// import { Server as HTTPServer } from 'http';
// import { Server as SocketServer } from 'socket.io';
// import { getRedisClient } from './redis.config';
// import { wsOptions } from './cors.config';

// let io: SocketServer;

// export const initializeWebSocket = async (httpServer: HTTPServer): Promise<void> => {
//     try {
//         io = new SocketServer(httpServer, {
//             cors: {
//                 cors: wsOptions,
//                 origin: "*", // Configure according to your needs
//                 methods: ["GET", "POST"]
//             },
//             adapter: await createAdapter() // You might want to add Redis adapter
//         });

//         io.on('connection', (socket) => {
//             console.log('New WebSocket connection:', socket.id);

//             socket.on('disconnect', () => {
//                 console.log('Client disconnected:', socket.id);
//             });

//             // Add your socket event handlers here
//             socket.on('join-room', (roomId: string) => {
//                 socket.join(roomId);
//             });

//             socket.on('leave-room', (roomId: string) => {
//                 socket.leave(roomId);
//             });
//         });

//         console.log('WebSocket Server Initialized');

//     } catch (error) {
//         console.error('WebSocket Initialization Error:', error);
//         throw error;
//     }
// };

// export const getIO = (): SocketServer => {
//     if (!io) {
//         throw new Error('Socket.io not initialized');
//     }
//     return io;
// };

// async function createAdapter() {
//     // If you want to use Redis adapter for WebSocket
//     // const redisClient = getRedisClient();
//     // const pubClient = redisClient.duplicate();
//     // const subClient = redisClient.duplicate();
//     // await Promise.all([pubClient.connect(), subClient.connect()]);
//     // return createAdapter(pubClient, subClient);
//     return undefined;
// }
