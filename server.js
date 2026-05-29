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
const roomTimeouts = new Map();   // roomId -> timeoutId (pentru ștergere întârziată)

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log(`🟢 Conectat: ${socket.id}`);

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
        console.log(`📁 Cameră creată: ${roomId} de ${socket.id}`);
    });

    socket.on('join_room', ({ roomId }) => {
        if (!roomId) return socket.emit('join_result', { success: false, error: 'ID invalid' });
        roomId = roomId.toUpperCase();
        if (!rooms.has(roomId)) {
            return socket.emit('join_result', { success: false, error: 'The room does not exist or has expired' });
        }
        // Dacă există timeout pentru această cameră, anulează-l (camera devine activă din nou)
        if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
            console.log(`⏰ Timeout anulat pentru camera ${roomId}`);
        }
        socket.join(roomId);
        rooms.get(roomId).add(socket.id);
        socket.emit('join_result', { success: true, roomId });
        const nick = userNicks.get(socket.id) || 'Anonim';
        socket.to(roomId).emit('room_notification', { roomId, text: `👤 ${nick} a intrat în cameră` });
        socket.emit('room_notification', { roomId, text: `✨ Bun venit în camera ${roomId}` });
        console.log(`🚪 ${socket.id} a intrat în ${roomId}`);
    });

    socket.on('chat_message', ({ roomId, message }) => {
        if (!roomId || !rooms.has(roomId)) return;
        const nick = userNicks.get(socket.id) || 'Anonim';
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
            const nick = userNicks.get(socket.id) || 'Cineva';
            socket.to(roomId).emit('room_notification', { roomId, text: `👋 ${nick} a părăsit camera` });
            
            if (rooms.get(roomId).size === 0) {
                // Dacă nu mai este nimeni, programăm ștergerea camerei după 5 minute
                const timeoutId = setTimeout(() => {
                    if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
                        rooms.delete(roomId);
                        roomTimeouts.delete(roomId);
                        console.log(`🧹 Cameră ștearsă după timeout (5 min): ${roomId}`);
                    }
                }, 5 * 60 * 1000); // 5 minute
                roomTimeouts.set(roomId, timeoutId);
                console.log(`⏳ Camera ${roomId} va fi ștearsă în 5 minute dacă nu revine nimeni.`);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`🔴 Deconectat: ${socket.id}`);
        for (let [roomId, members] of rooms.entries()) {
            if (members.has(socket.id)) {
                members.delete(socket.id);
                const nick = userNicks.get(socket.id) || 'Cineva';
                socket.to(roomId).emit('room_notification', { roomId, text: `👋 ${nick} a plecat (deconectat)` });
                if (members.size === 0 && !roomTimeouts.has(roomId)) {
                    const timeoutId = setTimeout(() => {
                        if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
                            rooms.delete(roomId);
                            roomTimeouts.delete(roomId);
                            console.log(`🧹 Cameră ștearsă după deconectare totală: ${roomId}`);
                        }
                    }, 5 * 60 * 1000);
                    roomTimeouts.set(roomId, timeoutId);
                }
            }
        }
        userNicks.delete(socket.id);
    });
});

// Servește fișierul index.html pentru testarea locală
app.get('/', (req, res) => {
    res.send('Backend Socket.IO is running. Use the frontend on Vercel.');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server pornit pe portul ${PORT}`);
});
