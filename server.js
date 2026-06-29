const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const rooms = new Map();          // roomId -> Set(socketIds)
const userNicks = new Map();      // socketId -> nick
const roomTimeouts = new Map();   // roomId -> timeoutId (for delayed deletion)

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.on('set_nickname', ({ nick }) => {
        const newNick = nick?.trim() || `Guest${Math.floor(Math.random()*1000)}`;
        userNicks.set(socket.id, newNick);
        socket.emit('nickname_changed', { newNick });
    });

    socket.on('create_room', () => {
        let roomId;
        do { roomId = generateRoomId(); } while (rooms.has(roomId));
        rooms.set(roomId, new Set([socket.id]));
        socket.join(roomId);
        socket.emit('room_created', { roomId });
        console.log(`Room created: ${roomId} by ${socket.id}`);
    });

    socket.on('join_room', ({ roomId }) => {
        if (!roomId) return socket.emit('join_result', { success: false, error: 'Invalid ID' });
        roomId = roomId.toUpperCase();
        if (!rooms.has(roomId)) {
            return socket.emit('join_result', { success: false, error: 'The room does not exist or has expired' });
        }
        
        // If there is a timeout for this room, cancel it (room becomes active again)
        if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
            console.log(`Timeout cancelled for room ${roomId}`);
        }
        
        socket.join(roomId);
        rooms.get(roomId).add(socket.id);
        socket.emit('join_result', { success: true, roomId });
        
        const nick = userNicks.get(socket.id) || 'Anonymous';
        socket.to(roomId).emit('room_notification', { roomId, text: `${nick} joined the room` });
        socket.emit('room_notification', { roomId, text: `Joined room ${roomId}` });
        console.log(`${socket.id} joined ${roomId}`);
    });

    socket.on('chat_message', ({ roomId, message }) => {
        if (!roomId || !rooms.has(roomId)) return;
        const nick = userNicks.get(socket.id) || 'Anonymous';
        io.to(roomId).emit('new_message', {
            roomId,
            nick,
            message: message.substring(0, 500),
            timestamp: Date.now()
        });
    });

    socket.on('leave_room', ({ roomId }) => {
        if (roomId && rooms.has(roomId)) {
            socket.leave(roomId);
            rooms.get(roomId).delete(socket.id);
            const nick = userNicks.get(socket.id) || 'Someone';
            socket.to(roomId).emit('room_notification', { roomId, text: `${nick} left the room` });
            
            if (rooms.get(roomId).size === 0) {
                // If no one is left, schedule room deletion after 5 minutes
                const timeoutId = setTimeout(() => {
                    if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
                        rooms.delete(roomId);
                        roomTimeouts.delete(roomId);
                        console.log(`Room deleted after timeout (5 min): ${roomId}`);
                    }
                }, 5 * 60 * 1000); // 5 minutes
                roomTimeouts.set(roomId, timeoutId);
                console.log(`Room ${roomId} will be deleted in 5 minutes if no one returns.`);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        for (let [roomId, members] of rooms.entries()) {
            if (members.has(socket.id)) {
                members.delete(socket.id);
                const nick = userNicks.get(socket.id) || 'Someone';
                socket.to(roomId).emit('room_notification', { roomId, text: `${nick} left (disconnected)` });
                
                if (members.size === 0 && !roomTimeouts.has(roomId)) {
                    const timeoutId = setTimeout(() => {
                        if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
                            rooms.delete(roomId);
                            roomTimeouts.delete(roomId);
                            console.log(`Room deleted after total disconnection: ${roomId}`);
                        }
                    }, 5 * 60 * 1000);
                    roomTimeouts.set(roomId, timeoutId);
                }
            }
        }
        userNicks.delete(socket.id);
    });
});

// Serve the index.html file for local testing
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
