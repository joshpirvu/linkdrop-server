document.addEventListener('DOMContentLoaded', function() {
    // Theme dark/light logic
    const themeToggleInput = document.getElementById('themeToggle');

    function setTheme(theme) {
        if (theme === 'dark') {
            document.body.classList.add('dark');
            localStorage.setItem('linkdrop-theme', 'dark');
            themeToggleInput.checked = true;
        } else {
            document.body.classList.remove('dark');
            localStorage.setItem('linkdrop-theme', 'light');
            themeToggleInput.checked = false;
        }
    }

    // Load saved theme on startup
    const savedTheme = localStorage.getItem('linkdrop-theme');
    if (savedTheme === 'light') {
        setTheme('light');
    } else {
        setTheme('dark');
    }

    // Listen for the toggle switch changing
    themeToggleInput.addEventListener('change', (e) => {
        setTheme(e.target.checked ? 'dark' : 'light');
    });

    // --- Socket.io ---
    const SOCKET_URL = 'https://linkdrop-server-k92j.onrender.com';
    const socket = io(SOCKET_URL, {
        reconnection: true,
        reconnectionAttempts: 20,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 5000,
        timeout: 20000
    });

    let currentRoomId = null;
    let myNick = '';
    let messageHistory = [];

    // DOM elements
    const homeView = document.getElementById('homeView');
    const chatView = document.getElementById('chatView');
    const makeBtn = document.getElementById('makeRoomBtn');
    const makeBtnText = document.getElementById('makeBtnText');
    const makeBtnSpinner = document.getElementById('makeBtnSpinner');
    const joinBtn = document.getElementById('joinRoomBtn');
    const joinBtnText = document.getElementById('joinBtnText');
    const joinBtnSpinner = document.getElementById('joinBtnSpinner');
    const joinInput = document.getElementById('joinRoomIdInput');
    const joinError = document.getElementById('joinErrorMsg');
    const roomIdSpan = document.getElementById('roomIdDisplay');
    const copyRoomBtn = document.getElementById('copyRoomIdBtn');
    const messagesDiv = document.getElementById('messagesContainer');
    const msgInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendMsgBtn');
    const leaveBtn = document.getElementById('leaveRoomBtn');
    const nickInput = document.getElementById('nicknameInput');
    const updateNickBtn = document.getElementById('updateNickBtn');
    const qrContainer = document.getElementById('qrContainer');
    const memberCountDisplay = document.getElementById('memberCountDisplay');

    // Handle create room loading state
    let createRoomTimeout = null;
    function setCreateRoomLoading(isLoading) {
        if (isLoading) {
            makeBtn.disabled = true;
            makeBtnText.style.display = 'none';
            makeBtnSpinner.style.display = 'inline-block';
            if (createRoomTimeout) clearTimeout(createRoomTimeout);
            createRoomTimeout = setTimeout(() => {
                if (makeBtn.disabled) {
                    setCreateRoomLoading(false);
                    addSystemMessage('Connection timeout.');
                }
            }, 10000);
        } else {
            makeBtn.disabled = false;
            makeBtnText.style.display = 'inline';
            makeBtnSpinner.style.display = 'none';
            if (createRoomTimeout) {
                clearTimeout(createRoomTimeout);
                createRoomTimeout = null;
            }
        }
    }

    // Handle join room loading state
    let joinRoomTimeout = null;
    function setJoinRoomLoading(isLoading) {
        if (isLoading) {
            joinBtn.disabled = true;
            joinBtnText.style.display = 'none';
            joinBtnSpinner.style.display = 'inline-block';
            if (joinRoomTimeout) clearTimeout(joinRoomTimeout);
            joinRoomTimeout = setTimeout(() => {
                if (joinBtn.disabled) {
                    setJoinRoomLoading(false);
                    addSystemMessage('Connection timeout.');
                    joinError.innerText = 'Server timeout. Please try again.';
                    joinError.classList.remove('hidden');
                    setTimeout(() => joinError.classList.add('hidden'), 4000);
                }
            }, 10000);
        } else {
            joinBtn.disabled = false;
            joinBtnText.style.display = 'inline';
            joinBtnSpinner.style.display = 'none';
            if (joinRoomTimeout) {
                clearTimeout(joinRoomTimeout);
                joinRoomTimeout = null;
            }
        }
    }

    function escapeHtml(str) {
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    function linkify(text) {
        const urlRegex = /((https?:\/\/[^\s]+)|(([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,20}(\/[^\s]*)?))/g;
        return text.replace(urlRegex, function(match) {
            const url = match.match(/^https?:\/\//) ? match : 'https://' + match;
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${match}</a>`;
        });
    }

    function addMessage(name, text, isOwn = false) {
        const div = document.createElement('div');
        div.className = 'message' + (isOwn ? ' own' : '');
        const safeText = escapeHtml(text);
        const linkedText = linkify(safeText);
        div.innerHTML = `<span class="msg-name">${escapeHtml(isOwn ? 'You' : name)}</span><div>${linkedText}</div>`;
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function addSystemMessage(text) {
        const sys = document.createElement('div');
        sys.className = 'system-message';
        sys.innerText = text;
        messagesDiv.appendChild(sys);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function clearMessages() { messagesDiv.innerHTML = ''; }

    function showHome() {
        homeView.classList.remove('hidden');
        chatView.classList.add('hidden');
        if (currentRoomId) socket.emit('leave_room', { roomId: currentRoomId });
        currentRoomId = null;
        messageHistory = [];
        clearMessages();
        joinError.classList.add('hidden');
        qrContainer.innerHTML = '';
        setCreateRoomLoading(false);
        setJoinRoomLoading(false);
    }

    function showChat(roomId) {
        homeView.classList.add('hidden');
        chatView.classList.remove('hidden');
        currentRoomId = roomId;
        roomIdSpan.innerText = roomId;
        memberCountDisplay.innerText = "...";
        clearMessages();
        addSystemMessage(`Joined room.`);
        msgInput.focus();

        socket.emit('request_history', { roomId });

        const directLink = `${window.location.origin}?room=${roomId}`;
        qrContainer.innerHTML = '';
        qrContainer.style.cursor = 'pointer';
        qrContainer.title = "Click to copy room link";

        qrContainer.onclick = () => {
            navigator.clipboard.writeText(directLink).then(() => {
                const originalTitle = qrContainer.title;
                qrContainer.title = "Copied!";
                qrContainer.style.borderColor = "#1c6d8f";
                setTimeout(() => {
                    qrContainer.title = originalTitle;
                    qrContainer.style.borderColor = "transparent";
                }, 1500);
            });
        };

        try {
            new QRCode(qrContainer, {
                text: directLink,
                width: 100,
                height: 100,
                colorDark: "#1a2332",
                colorLight: "#ffffff"
            });
        } catch(e) { console.warn("QR error", e); }
    }

    function generateRandomNick() {
        const names = ["Pixel", "Wave", "Echo", "Nova", "Luma", "Zest", "Chess"];
        return names[Math.floor(Math.random()*names.length)] + Math.floor(Math.random()*900+100);
    }

    function updateNickname(nick) {
        if (!nick || !nick.trim()) nick = generateRandomNick();
        const requestedNick = nick.trim().substring(0, 20);
        socket.emit('set_nickname', { nick: requestedNick });
    }

    function sendMessage() {
        const text = msgInput.value.trim();
        if (!text || !currentRoomId) return;
        socket.emit('chat_message', { roomId: currentRoomId, message: text });
        msgInput.value = '';
        msgInput.focus();
    }

    // Socket event listeners
    socket.on('connect', () => {
        const sysMessages = document.querySelectorAll('.system-message.reconnecting');
        sysMessages.forEach(msg => msg.remove());
        updateNickname(myNick || generateRandomNick());
        console.log('Connected to server');
    });

    socket.on('disconnect', () => {
        if (currentRoomId && !document.querySelector('.system-message.reconnecting')) {
            addSystemMessage('Disconnected from server. Attempting to reconnect...');
            const lastMsg = messagesDiv.lastElementChild;
            if (lastMsg) lastMsg.classList.add('reconnecting');
        }
    });

    socket.on('connect_error', () => {
        if (currentRoomId && !document.querySelector('.system-message.reconnecting')) {
            addSystemMessage('Connection lost. Reconnecting...');
            const lastMsg = messagesDiv.lastElementChild;
            if (lastMsg) lastMsg.classList.add('reconnecting');
        }
    });

    socket.on('nickname_changed', (data) => {
        const oldNick = myNick;
        myNick = data.newNick;
        nickInput.value = myNick;
        if (oldNick && oldNick !== myNick) {
            addSystemMessage(`Name updated to ${myNick}.`);
        }
    });

    socket.on('nickname_error', (data) => {
        addSystemMessage('⚠️ ' + data.error);
        nickInput.value = myNick;
    });

    socket.on('room_error', (data) => {
        addSystemMessage('⚠️ ' + data.error + ' Returning home...');
        setTimeout(() => {
            showHome();
        }, 3000);
    });

    socket.on('new_message', (data) => {
        if (data.roomId === currentRoomId) {
            messageHistory.push({ nick: data.nick, message: data.message });
            addMessage(data.nick, data.message, data.nick === myNick);
        }
    });

    socket.on('request_history', (data) => {
        socket.emit('send_history', {
            requesterId: data.requesterId,
            history: messageHistory
        });
    });

    socket.on('history_response', (data) => {
        const historicalMessages = data.history || [];
        messageHistory = [...historicalMessages, ...messageHistory];
        const fragment = document.createDocumentFragment();
        historicalMessages.forEach(msg => {
            const div = document.createElement('div');
            div.className = 'message' + (msg.nick === myNick ? ' own' : '');
            const safeText = escapeHtml(msg.message);
            const linkedText = linkify(safeText);
            div.innerHTML = `<span class="msg-name">${escapeHtml(msg.nick === myNick ? 'You' : msg.nick)}</span><div>${linkedText}</div>`;
            fragment.appendChild(div);
        });
        messagesDiv.insertBefore(fragment, messagesDiv.firstChild);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    });

    socket.on('room_notification', (notif) => {
        if (notif.roomId === currentRoomId) {
            addSystemMessage(notif.text);
        }
    });

    socket.on('member_count', (data) => {
        if (memberCountDisplay) {
            memberCountDisplay.innerText = data.count;
        }
    });

    socket.on('room_created', (data) => {
        setCreateRoomLoading(false);
        showChat(data.roomId);
    });

    socket.on('join_result', (data) => {
        setJoinRoomLoading(false);
        if (data.success) {
            showChat(data.roomId);
        } else {
            joinError.innerText = data.error || 'Room does not exist';
            joinError.classList.remove('hidden');
            setTimeout(() => joinError.classList.add('hidden'), 3000);
        }
    });

    // UI Event Listeners
    makeBtn.addEventListener('click', () => {
        setCreateRoomLoading(true);
        socket.emit('create_room');
    });

    joinBtn.addEventListener('click', () => {
        const rid = joinInput.value.trim().toUpperCase();
        if (!rid) {
            joinError.innerText = 'Enter an ID';
            joinError.classList.remove('hidden');
            setTimeout(() => joinError.classList.add('hidden'), 2000);
            return;
        }
        setJoinRoomLoading(true);
        socket.emit('join_room', { roomId: rid });
    });

    sendBtn.addEventListener('click', sendMessage);
    msgInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
    leaveBtn.addEventListener('click', showHome);

    copyRoomBtn.addEventListener('click', () => {
        if (currentRoomId) {
            navigator.clipboard.writeText(currentRoomId);
            const originalText = copyRoomBtn.innerHTML;
            copyRoomBtn.innerHTML = '<i class="ph ph-check"></i> Copied';
            setTimeout(() => {
                copyRoomBtn.innerHTML = originalText;
            }, 2000);
        }
    });

    updateNickBtn.addEventListener('click', () => updateNickname(nickInput.value));
    nickInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') updateNickname(nickInput.value); });

    // Auto-join from URL
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
        joinInput.value = roomFromUrl.toUpperCase();
        setTimeout(() => joinBtn.click(), 500);
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    updateNickname(generateRandomNick());
});
