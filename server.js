const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }   // permisiv pentru testare; poți restricționa mai târziu
});

// Stocare camere active: { roomId: Set(socketIds) }
const rooms = new Map();
// Stocare nickname-uri: { socketId: nick }
const userNicks = new Map();

// Generează un room ID scurt (6 caractere alfanumerice)
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log(`🟢 Client conectat: ${socket.id}`);

    // Setează nickname
    socket.on('set_nickname', ({ nick }) => {
        const newNick = nick?.trim() || `Guest${Math.floor(Math.random()*1000)}`;
        userNicks.set(socket.id, newNick);
        socket.emit('nickname_changed', { newNick });
        console.log(`📝 Nickname set: ${newNick} pentru ${socket.id}`);
    });

    // Creează o cameră nouă
    socket.on('create_room', () => {
        let roomId;
        do {
            roomId = generateRoomId();
        } while (rooms.has(roomId));

        rooms.set(roomId, new Set([socket.id]));
        socket.join(roomId);
        socket.emit('room_created', { roomId });
        console.log(`🏠 Cameră creată: ${roomId} de ${socket.id}`);
    });

    // Intră într-o cameră existentă
    socket.on('join_room', ({ roomId }) => {
        if (!roomId) {
            socket.emit('join_result', { success: false, error: 'ID invalid' });
            return;
        }
        roomId = roomId.toUpperCase();
        if (!rooms.has(roomId)) {
            socket.emit('join_result', { success: false, error: 'Camera nu există' });
            return;
        }

        socket.join(roomId);
        rooms.get(roomId).add(socket.id);
        socket.emit('join_result', { success: true, roomId });

        const nick = userNicks.get(socket.id) || 'Anonim';
        socket.to(roomId).emit('room_notification', {
            roomId,
            text: `👤 ${nick} a intrat în cameră`
        });
        socket.emit('room_notification', {
            roomId,
            text: `✨ Bun venit în camera ${roomId}`
        });
        console.log(`🚪 ${socket.id} a intrat în camera ${roomId}`);
    });

    // Trimite un mesaj în cameră
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

    // Părăsire cameră (cerere explicită)
    socket.on('leave_room', ({ roomId }) => {
        if (roomId && rooms.has(roomId)) {
            socket.leave(roomId);
            rooms.get(roomId).delete(socket.id);
            const nick = userNicks.get(socket.id) || 'Cineva';
            socket.to(roomId).emit('room_notification', {
                roomId,
                text: `👋 ${nick} a părăsit camera`
            });
            if (rooms.get(roomId).size === 0) {
                rooms.delete(roomId);
                console.log(`🧹 Cameră ștearsă (goală): ${roomId}`);
            }
        }
    });

    // Deconectare neașteptată
    socket.on('disconnect', () => {
        console.log(`🔴 Deconectat: ${socket.id}`);
        for (let [roomId, members] of rooms.entries()) {
            if (members.has(socket.id)) {
                members.delete(socket.id);
                const nick = userNicks.get(socket.id) || 'Cineva';
                socket.to(roomId).emit('room_notification', {
                    roomId,
                    text: `👋 ${nick} a părăsit camera (deconectat)`
                });
                if (members.size === 0) {
                    rooms.delete(roomId);
                    console.log(`🧹 Cameră ștearsă: ${roomId}`);
                }
            }
        }
        userNicks.delete(socket.id);
    });
});

// Servește fișierul index.html (pentru testare locală)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server rulând pe http://localhost:${PORT}`);
});