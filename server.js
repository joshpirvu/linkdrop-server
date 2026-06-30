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

const ROOM_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    // Set Nickname with Stealing Prevention
    socket.on('set_nickname', ({ nick }) => {
        let requestedNick = nick?.trim() || `Guest${Math.floor(Math.random()*1000)}`;
        
        let isTaken = false;
        for (const [id, existingNick] of userNicks.entries()) {
            if (existingNick.toLowerCase() === requestedNick.toLowerCase() && id !== socket.id) {
                isTaken = true;
                break;
            }
        }

        if (isTaken) {
            if (!userNicks.has(socket.id)) {
                requestedNick = `${requestedNick}${Math.floor(Math.random()*100)}`;
                userNicks.set(socket.id, requestedNick);
                socket.emit('nickname_changed', { newNick: requestedNick });
            } else {
                socket.emit('nickname_error', { error: 'That name is already taken!' });
            }
        } else {
            userNicks.set(socket.id, requestedNick);
            socket.emit('nickname_changed', { newNick: requestedNick });
        }
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
        
        if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
        }
        
        socket.join(roomId);
        rooms.get(roomId).add(socket.id);
        socket.emit('join_result', { success: true, roomId });
        
        const nick = userNicks.get(socket.id) || 'Anonymous';
        socket.to(roomId).emit('room_notification', { roomId, text: `${nick} joined the room` });
        socket.emit('room_notification', { roomId, text: `Joined room ${roomId}` });
        io.to(roomId).emit('member_count', { count: rooms.get(roomId).size });
    });

    socket.on('chat_message', ({ roomId, message }) => {
        if (!roomId || !rooms.has(roomId)) {
            return socket.emit('room_error', { error: 'Room does not exist or has expired.' });
        }
        const nick = userNicks.get(socket.id) || 'Anonymous';
        io.to(roomId).emit('new_message', {
            roomId,
            nick,
            message: message.substring(0, 2000), // Increased length for E2EE keys
            timestamp: Date.now()
        });
    });

    // Handle Typing Indicators
    socket.on('typing', ({ roomId, isTyping }) => {
        if (!roomId || !rooms.has(roomId)) return;
        const nick = userNicks.get(socket.id) || 'Someone';
        socket.to(roomId).emit('user_typing', { nick, isTyping });
    });

    // P2P History Sync Signalling
    socket.on('request_history', ({ roomId }) => {
        if (!roomId || !rooms.has(roomId)) return;
        const members = rooms.get(roomId);
        
        if (members && members.size > 1) {
            let masterId = null;
            for (const memberId of members) {
                if (memberId !== socket.id) { masterId = memberId; break; }
            }
            if (masterId) io.to(masterId).emit('request_history', { requesterId: socket.id });
        }
    });

    socket.on('send_history', ({ requesterId, history }) => {
        io.to(requesterId).emit('history_response', { history });
    });

    socket.on('leave_room', ({ roomId }) => {
        if (roomId && rooms.has(roomId)) {
            socket.leave(roomId);
            rooms.get(roomId).delete(socket.id);
            const nick = userNicks.get(socket.id) || 'Someone';
            socket.to(roomId).emit('room_notification', { roomId, text: `${nick} left the room` });
            io.to(roomId).emit('member_count', { count: rooms.get(roomId).size });
            
            if (rooms.get(roomId).size === 0) {
                const timeoutId = setTimeout(() => {
                    if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
                        rooms.delete(roomId);
                        roomTimeouts.delete(roomId);
                    }
                }, ROOM_TIMEOUT_MS);
                roomTimeouts.set(roomId, timeoutId);
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
                io.to(roomId).emit('member_count', { count: members.size });
                
                if (members.size === 0 && !roomTimeouts.has(roomId)) {
                    const timeoutId = setTimeout(() => {
                        if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
                            rooms.delete(roomId);
                            roomTimeouts.delete(roomId);
                        }
                    }, ROOM_TIMEOUT_MS);
                    roomTimeouts.set(roomId, timeoutId);
                }
            }
        }
        userNicks.delete(socket.id);
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
