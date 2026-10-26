const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    // Socket.io's default is 1 MB per packet, which would disconnect anyone sending an image.
    // Pasted images are compressed to ~375 KB in the browser; the extra headroom is for history sync payloads.
    maxHttpBufferSize: 10 * 1024 * 1024
});

const rooms = new Map();          // roomId -> Set(socketIds)
const userNicks = new Map();      // socketId -> nick
const roomTimeouts = new Map();   // roomId -> timeoutId (for delayed deletion)
const roomHistory = new Map();    // roomId -> [message entries, oldest first] (server-side history buffer)
const clientIds = new Map();      // socketId -> clientId (a private token each browser keeps; it is never broadcast)

// Set room survival to 1 hour
const ROOM_TIMEOUT_MS = 60 * 60 * 1000;
const ROOM_TIMEOUT_LABEL = `${Math.round(ROOM_TIMEOUT_MS / 60000)} minutes`;

// Server-side history buffer: in memory only, deleted together with the room
const HISTORY_MAX_MESSAGES = 100;                   // Messages kept per room
const HISTORY_IMAGE_BUDGET = 4 * 1024 * 1024;       // Image data kept per room; the oldest images are dropped first
const HISTORY_SYNC_IMAGE_BUDGET = 3 * 1024 * 1024;  // Image data in one history payload; older images become placeholders

// Image messages: only base64 data URLs of these types are relayed, and never above this size
const MAX_IMAGE_CHARS = 1.5 * 1024 * 1024;   // Well above what the browser sends after compression
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/]+=*$/;

// Message features
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥']; // 👍 ❤️ 😂 😮 😢 🔥 (must match index.html)
const REPLY_SNIPPET_CHARS = 120;
const MESSAGE_MAX_CHARS = 3000;
const NICK_MAX_CHARS = 20;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Rate limits per socket: [max events, window in ms]. Going over a limit drops the event
// (the sender is told once per window); nobody is ever disconnected for it.
const RATE_LIMITS = {
    chat_message:    [12, 10 * 1000],
    image:           [8, 60 * 1000],
    react:           [30, 10 * 1000],
    typing:          [30, 10 * 1000],
    delete_message:  [10, 10 * 1000],
    set_nickname:    [10, 10 * 1000],
    create_room:     [5, 10 * 1000],
    join_room:       [10, 10 * 1000],
    leave_room:      [20, 10 * 1000],
    request_history: [10, 10 * 1000],
    check_room:      [20, 10 * 1000]
};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateMessageId() {
    return crypto.randomBytes(6).toString('hex');
}

// Registers a handler that can never crash the server: a missing or malformed payload
// arrives as {}, and anything thrown inside is logged instead of taking the process down.
function on(socket, event, handler) {
    socket.on(event, (payload) => {
        try {
            handler(payload && typeof payload === 'object' ? payload : {});
        } catch (err) {
            console.error(`Error handling "${event}" from ${socket.id}:`, err);
        }
    });
}

function allow(socket, key) {
    const limit = RATE_LIMITS[key];
    if (!limit) return true;
    const [max, windowMs] = limit;
    const now = Date.now();
    const buckets = socket.data.rate || (socket.data.rate = {});
    let bucket = buckets[key];
    if (!bucket || now - bucket.start >= windowMs) {
        bucket = buckets[key] = { start: now, count: 0 };
    }
    bucket.count++;
    if (bucket.count > max) {
        if (bucket.count === max + 1) {
            socket.emit('rate_limited', { action: key, retryInMs: windowMs - (now - bucket.start) });
        }
        return false;
    }
    return true;
}

function cleanRoomId(roomId) {
    return typeof roomId === 'string' ? roomId.trim().toUpperCase() : '';
}

function isMember(socket, roomId) {
    const members = rooms.get(roomId);
    return !!members && members.has(socket.id);
}

function roomsOf(socketId) {
    const out = [];
    for (const [roomId, members] of rooms.entries()) {
        if (members.has(socketId)) out.push(roomId);
    }
    return out;
}

// A name is taken when another person in the room uses it. Other connections of the same
// browser (a second tab, or an old connection that is still timing out) don't count.
function nickTakenInRoom(roomId, nick, socket) {
    const members = rooms.get(roomId);
    if (!members) return false;
    const wanted = nick.toLowerCase();
    const myClientId = clientIds.get(socket.id);
    for (const id of members) {
        if (id === socket.id) continue;
        if (clientIds.get(id) === myClientId) continue;
        if ((userNicks.get(id) || '').toLowerCase() === wanted) return true;
    }
    return false;
}

function nickTakenInRooms(roomIds, nick, socket) {
    return roomIds.some((roomId) => nickTakenInRoom(roomId, nick, socket));
}

// Finds a variant of the name ("Josh" -> "Josh42") that nobody in these rooms uses
function freeNickForRooms(roomIds, nick, socket) {
    if (!nickTakenInRooms(roomIds, nick, socket)) return nick;
    for (let digits = 2; digits <= 4; digits++) {
        for (let attempt = 0; attempt < 20; attempt++) {
            const suffix = String(Math.floor(Math.random() * Math.pow(10, digits)));
            const candidate = nick.substring(0, NICK_MAX_CHARS - suffix.length) + suffix;
            if (!nickTakenInRooms(roomIds, candidate, socket)) return candidate;
        }
    }
    return `Guest${Math.floor(Math.random() * 100000)}`;
}

// Members are counted per browser, not per connection: a second tab, or an old connection
// that is still timing out after a network change, doesn't show up as an extra person
function broadcastMembers(roomId) {
    const members = rooms.get(roomId);
    if (!members) return;
    const seen = new Set();
    const list = [];
    for (const id of members) {
        const key = clientIds.get(id) || id;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(userNicks.get(id) || 'Anonymous');
    }
    io.to(roomId).emit('member_count', { roomId, count: list.length });
    io.to(roomId).emit('member_list', { roomId, members: list });
}

// Sends an event to every member of a room with a payload built for that member
// (used for the per-person fields such as "own" and "mine")
function sendToMembers(roomId, event, buildPayload) {
    const members = rooms.get(roomId);
    if (!members) return;
    for (const id of members) {
        io.to(id).emit(event, buildPayload(clientIds.get(id)));
    }
}

function scheduleRoomCleanup(roomId, reason) {
    if (roomTimeouts.has(roomId)) return;
    const timeoutId = setTimeout(() => {
        roomTimeouts.delete(roomId);
        if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
            rooms.delete(roomId);
            roomHistory.delete(roomId);
            console.log(`Room deleted after ${ROOM_TIMEOUT_LABEL} with nobody in it: ${roomId}`);
        }
    }, ROOM_TIMEOUT_MS);
    roomTimeouts.set(roomId, timeoutId);
    console.log(`Room ${roomId} will be deleted in ${ROOM_TIMEOUT_LABEL} if no one returns (${reason}).`);
}

function removeFromRoom(socket, roomId, text) {
    const members = rooms.get(roomId);
    if (!members || !members.has(socket.id)) return;
    members.delete(socket.id);
    socket.leave(roomId);
    const nick = userNicks.get(socket.id) || 'Someone';
    socket.to(roomId).emit('room_notification', { roomId, text: `${nick} ${text}` });
    broadcastMembers(roomId);
    if (members.size === 0) scheduleRoomCleanup(roomId, 'room is empty');
}

// --- History buffer ---

function findMessage(roomId, messageId) {
    const history = roomHistory.get(roomId);
    if (!history || typeof messageId !== 'string') return null;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].id === messageId) return history[i];
    }
    return null;
}

function pushHistory(roomId, entry) {
    let history = roomHistory.get(roomId);
    if (!history) {
        history = [];
        roomHistory.set(roomId, history);
    }
    history.push(entry);
    while (history.length > HISTORY_MAX_MESSAGES) history.shift();

    // Keep the stored image data within budget by dropping the oldest images first
    let imageChars = 0;
    for (const m of history) if (m.image) imageChars += m.image.length;
    for (let i = 0; i < history.length && imageChars > HISTORY_IMAGE_BUDGET; i++) {
        const m = history[i];
        if (m.image) {
            imageChars -= m.image.length;
            m.image = null;
            m.imageOmitted = true;
        }
    }
}

function reactionSummary(entry) {
    const out = {};
    for (const [emoji, who] of entry.reactions.entries()) {
        if (who.size) out[emoji] = Array.from(who.values());
    }
    return out;
}

function myReactions(entry, clientId) {
    const out = [];
    for (const [emoji, who] of entry.reactions.entries()) {
        if (who.has(clientId)) out.push(emoji);
    }
    return out;
}

function quoteSnippet(entry) {
    if (entry.message) return entry.message.substring(0, REPLY_SNIPPET_CHARS);
    return (entry.image || entry.imageOmitted) ? '📷 Photo' : '';
}

// The message as a given member should see it ("own" and "mine" depend on who is looking)
function publicMessage(entry, roomId, clientId) {
    return {
        roomId,
        id: entry.id,
        nick: entry.nick,
        message: entry.message,
        image: entry.image,
        imageOmitted: entry.imageOmitted,
        timestamp: entry.timestamp,
        replyTo: entry.replyTo,
        reactions: reactionSummary(entry),
        mine: myReactions(entry, clientId),
        own: entry.senderClientId === clientId
    };
}

function historyFor(roomId, clientId) {
    const history = roomHistory.get(roomId) || [];
    const out = [];
    let imageChars = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        if (entry.deleted) continue;
        const msg = publicMessage(entry, roomId, clientId);
        if (msg.image) {
            if (imageChars + msg.image.length <= HISTORY_SYNC_IMAGE_BUDGET) {
                imageChars += msg.image.length;
            } else {
                msg.image = null;
                msg.imageOmitted = true;
            }
        }
        out.push(msg);
    }
    return out.reverse();
}

io.on('connection', (socket) => {
    // The browser sends its private client id in the connection handshake, so the same person
    // is recognised after a reconnect or a page reload (used for "own message", reactions, deletes)
    const auth = (socket.handshake && socket.handshake.auth) || {};
    const clientId = (typeof auth.clientId === 'string' && CLIENT_ID_PATTERN.test(auth.clientId))
        ? auth.clientId
        : crypto.randomBytes(16).toString('hex');
    clientIds.set(socket.id, clientId);
    console.log(`Connected: ${socket.id}`);

    on(socket, 'set_nickname', ({ nick }) => {
        if (!allow(socket, 'set_nickname')) return;
        let requestedNick = (typeof nick === 'string' ? nick.trim() : '').substring(0, NICK_MAX_CHARS)
            || `Guest${Math.floor(Math.random()*1000)}`;
        const currentNick = userNicks.get(socket.id);
        const myRooms = roomsOf(socket.id);

        // Names only have to be unique inside the rooms this person is in
        if (nickTakenInRooms(myRooms, requestedNick, socket)) {
            if (!currentNick) {
                // First name of this connection: pick a free variant instead of failing
                requestedNick = freeNickForRooms(myRooms, requestedNick, socket);
            } else {
                // Otherwise, reject the manual change
                return socket.emit('nickname_error', { error: 'That name is already taken in this room!' });
            }
        }

        userNicks.set(socket.id, requestedNick);
        socket.emit('nickname_changed', { newNick: requestedNick });

        if (currentNick && currentNick !== requestedNick) {
            for (const roomId of myRooms) {
                socket.to(roomId).emit('room_notification', { roomId, text: `${currentNick} is now known as ${requestedNick}` });
                broadcastMembers(roomId);
            }
        }
    });

    on(socket, 'create_room', () => {
        if (!allow(socket, 'create_room')) return;
        let roomId;
        do { roomId = generateRoomId(); } while (rooms.has(roomId));
        rooms.set(roomId, new Set([socket.id]));
        roomHistory.set(roomId, []);
        socket.join(roomId);
        socket.emit('room_created', { roomId });
        broadcastMembers(roomId);
        console.log(`Room created: ${roomId} by ${socket.id}`);
    });

    on(socket, 'join_room', ({ roomId }) => {
        if (!allow(socket, 'join_room')) return;
        roomId = cleanRoomId(roomId);
        if (!roomId) return socket.emit('join_result', { success: false, error: 'Invalid ID' });
        if (!rooms.has(roomId)) {
            return socket.emit('join_result', { success: false, roomId, error: 'The room does not exist or has expired' });
        }

        // If there is a timeout for this room, cancel it (room becomes active again)
        if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
            console.log(`Timeout cancelled for room ${roomId}`);
        }

        // The name must be unique within this room
        let nick = userNicks.get(socket.id) || `Guest${Math.floor(Math.random()*1000)}`;
        let renamedFrom = null;
        if (nickTakenInRoom(roomId, nick, socket)) {
            renamedFrom = nick;
            nick = freeNickForRooms([roomId], nick, socket);
        }
        userNicks.set(socket.id, nick);

        const alreadyMember = isMember(socket, roomId);
        socket.join(roomId);
        rooms.get(roomId).add(socket.id);
        socket.emit('join_result', { success: true, roomId });
        // Sent after join_result on purpose: the page clears the chat when it enters a room,
        // and this notice has to survive that
        if (renamedFrom) {
            socket.emit('nickname_changed', { newNick: nick, oldNick: renamedFrom, reason: 'taken' });
        }

        if (!alreadyMember) {
            socket.to(roomId).emit('room_notification', { roomId, text: `${nick} joined the room` });
        }
        socket.emit('room_notification', { roomId, text: `Joined room ${roomId}` });

        // Broadcast the updated member count and list to everyone in the room
        broadcastMembers(roomId);
        console.log(`${socket.id} joined ${roomId}. Members: ${rooms.get(roomId).size}`);
    });

    on(socket, 'chat_message', ({ roomId, message, image, replyTo }) => {
        roomId = cleanRoomId(roomId);
        if (!roomId || !rooms.has(roomId)) {
            // Tell the frontend that the room expired so it can recover gracefully
            return socket.emit('room_error', { error: 'Room does not exist or has expired.' });
        }
        const text = typeof message === 'string' ? message.substring(0, MESSAGE_MAX_CHARS) : '';
        const hasImage = typeof image === 'string' && image.length <= MAX_IMAGE_CHARS && IMAGE_DATA_URL_PATTERN.test(image);
        if (!text && !hasImage) return; // Nothing to send
        if (!allow(socket, 'chat_message')) return;
        if (hasImage && !allow(socket, 'image')) return;

        const nick = userNicks.get(socket.id) || 'Anonymous';
        const entry = {
            id: generateMessageId(),
            nick,
            senderClientId: clientIds.get(socket.id),
            message: text,
            image: hasImage ? image : null,
            imageOmitted: false,
            timestamp: Date.now(),
            replyTo: null,
            reactions: new Map(),   // emoji -> Map(clientId -> nick)
            deleted: false
        };

        // Quotes are taken from the buffer, so a reply can't claim someone said something they didn't
        if (typeof replyTo === 'string') {
            const original = findMessage(roomId, replyTo);
            if (original && !original.deleted) {
                entry.replyTo = { id: original.id, nick: original.nick, text: quoteSnippet(original) };
            }
        }

        pushHistory(roomId, entry);
        sendToMembers(roomId, 'new_message', (memberClientId) => publicMessage(entry, roomId, memberClientId));
        // A sender whose rejoin after a reconnect hasn't landed yet still gets their own message
        if (!isMember(socket, roomId)) {
            socket.emit('new_message', publicMessage(entry, roomId, clientIds.get(socket.id)));
        }
    });

    on(socket, 'react', ({ roomId, messageId, emoji }) => {
        if (!allow(socket, 'react')) return;
        roomId = cleanRoomId(roomId);
        if (!isMember(socket, roomId)) return;
        if (!REACTION_EMOJIS.includes(emoji)) return;
        const entry = findMessage(roomId, messageId);
        if (!entry || entry.deleted) return;

        const myClientId = clientIds.get(socket.id);
        const nick = userNicks.get(socket.id) || 'Anonymous';
        let who = entry.reactions.get(emoji);
        if (!who) {
            who = new Map();
            entry.reactions.set(emoji, who);
        }
        if (who.has(myClientId)) {
            who.delete(myClientId);
            if (who.size === 0) entry.reactions.delete(emoji);
        } else {
            who.set(myClientId, nick);
        }

        const reactions = reactionSummary(entry);
        sendToMembers(roomId, 'reaction_update', (memberClientId) => ({
            roomId, messageId: entry.id, reactions, mine: myReactions(entry, memberClientId)
        }));
    });

    on(socket, 'delete_message', ({ roomId, messageId }) => {
        if (!allow(socket, 'delete_message')) return;
        roomId = cleanRoomId(roomId);
        if (!isMember(socket, roomId)) return;
        const entry = findMessage(roomId, messageId);
        if (!entry || entry.deleted) return;
        if (entry.senderClientId !== clientIds.get(socket.id)) {
            return socket.emit('action_error', { error: 'You can only delete your own messages.' });
        }
        entry.deleted = true;
        entry.message = '';
        entry.image = null;
        entry.imageOmitted = false;
        entry.replyTo = null;
        entry.reactions.clear();
        io.to(roomId).emit('message_deleted', { roomId, messageId: entry.id });
    });

    on(socket, 'typing', ({ roomId, typing }) => {
        if (!allow(socket, 'typing')) return;
        roomId = cleanRoomId(roomId);
        if (!isMember(socket, roomId)) return;
        socket.to(roomId).emit('typing', { roomId, nick: userNicks.get(socket.id) || 'Anonymous', typing: !!typing });
    });

    // History comes straight from the server's buffer, so it no longer depends on another
    // member's browser being awake to answer
    on(socket, 'request_history', ({ roomId }) => {
        if (!allow(socket, 'request_history')) return;
        roomId = cleanRoomId(roomId);
        if (!roomId || !rooms.has(roomId)) return;
        socket.emit('history_response', { roomId, history: historyFor(roomId, clientIds.get(socket.id)) });
    });

    // Lets a returning visitor know whether the room they were in still exists
    on(socket, 'check_room', ({ roomId }) => {
        if (!allow(socket, 'check_room')) return;
        roomId = cleanRoomId(roomId);
        if (!roomId) return;
        socket.emit('room_check', { roomId, exists: rooms.has(roomId) });
    });

    on(socket, 'leave_room', ({ roomId }) => {
        if (!allow(socket, 'leave_room')) return;
        roomId = cleanRoomId(roomId);
        if (!roomId) return;
        removeFromRoom(socket, roomId, 'left the room');
    });

    on(socket, 'disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        for (const roomId of roomsOf(socket.id)) {
            removeFromRoom(socket, roomId, 'left (disconnected)');
        }
        userNicks.delete(socket.id);
        clientIds.delete(socket.id);
    });
});

app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Files the installable app needs (manifest, icons, service worker). Only this allowlist is
// served, so the server source and package files are never exposed.
const PUBLIC_FILES = new Set(['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']);
app.get('/:file', (req, res, next) => {
    const file = req.params.file;
    if (!PUBLIC_FILES.has(file)) return next();
    if (file.endsWith('.webmanifest')) res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, file));
});

// Share target fallback: the service worker normally handles /share itself; if it isn't active
// the request lands here and the visitor is simply sent to the app
app.post('/share', (req, res) => res.redirect(303, '/'));
app.get('/share', (req, res) => res.redirect(302, '/'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

// --- GLOBAL CRASH HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Uncaught Exception):', err);
    // Prevents the server from shutting down completely
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL ERROR (Unhandled Rejection):', reason);
    // Prevents the server from shutting down completely
});
