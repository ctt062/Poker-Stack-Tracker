/**
 * Room sync layer: multi-device shared session via Firebase Auth (anon) + Firestore.
 * If Firebase is not configured, create/join is disabled and the app stays local-only.
 */
(function (global) {
    'use strict';

    const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
    const CODE_LENGTH = 5;
    const PRESENCE_MS = 20000;
    const STALE_MS = 60000;

    let auth = null;
    let db = null;
    let unsubRoom = null;
    let presenceTimer = null;
    let applyingRemote = false;
    let initialized = false;

    /** @type {null | {
     *   roomId: string,
     *   code: string,
     *   hostId: string,
     *   status: string,
     *   role: 'host' | 'editor' | 'viewer',
     *   displayName: string,
     *   participantId: string,
     *   participants: Record<string, object>,
     *   game: object | null
     * }} */
    let roomState = null;

    const listeners = {
        room: [],
        game: [],
        error: []
    };

    function isConfigured() {
        const c = global.FIREBASE_CONFIG;
        return !!(c && c.apiKey && c.projectId && c.appId);
    }

    function emit(event, payload) {
        (listeners[event] || []).forEach((fn) => {
            try { fn(payload); } catch (e) { console.error(e); }
        });
    }

    function on(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
        return () => {
            listeners[event] = listeners[event].filter((f) => f !== fn);
        };
    }

    function generateCode() {
        let code = '';
        const arr = new Uint32Array(CODE_LENGTH);
        crypto.getRandomValues(arr);
        for (let i = 0; i < CODE_LENGTH; i++) {
            code += CODE_CHARS[arr[i] % CODE_CHARS.length];
        }
        return code;
    }

    function sharedGameFromLocal(gameState) {
        return {
            blindStructure: gameState.blindStructure,
            stackAmount: gameState.stackAmount,
            players: gameState.players,
            sessionName: gameState.sessionName,
            bankerName: gameState.bankerName
        };
    }

    function serverTs() {
        return global.firebase.firestore.FieldValue.serverTimestamp();
    }

    async function ensureFirebase() {
        if (initialized) return true;
        if (!isConfigured()) return false;
        if (!global.firebase) {
            throw new Error('Firebase SDK not loaded');
        }

        if (!global.firebase.apps.length) {
            global.firebase.initializeApp(global.FIREBASE_CONFIG);
        }
        auth = global.firebase.auth();
        db = global.firebase.firestore();

        if (!auth.currentUser) {
            await auth.signInAnonymously();
        }

        initialized = true;
        return true;
    }

    function uid() {
        return auth && auth.currentUser ? auth.currentUser.uid : null;
    }

    function canEdit() {
        if (!roomState) return true; // solo mode
        if (roomState.status === 'ended') return false;
        return roomState.role === 'host' || roomState.role === 'editor';
    }

    function isHost() {
        return !!(roomState && roomState.role === 'host');
    }

    function isInRoom() {
        return !!(roomState && roomState.roomId);
    }

    function isApplyingRemote() {
        return applyingRemote;
    }

    function getRoomSnapshot() {
        if (!roomState) return null;
        return {
            roomId: roomState.roomId,
            code: roomState.code,
            hostId: roomState.hostId,
            status: roomState.status,
            role: roomState.role,
            displayName: roomState.displayName,
            participantId: roomState.participantId,
            participants: { ...roomState.participants },
            canEdit: canEdit(),
            isHost: isHost()
        };
    }

    function stopPresence() {
        if (presenceTimer) {
            clearInterval(presenceTimer);
            presenceTimer = null;
        }
    }

    function startPresence() {
        stopPresence();
        presenceTimer = setInterval(() => {
            touchPresence().catch(() => {});
        }, PRESENCE_MS);
        touchPresence().catch(() => {});
    }

    async function touchPresence() {
        if (!roomState || !db || !uid()) return;
        await db.collection('rooms').doc(roomState.roomId).update({
            [`participants.${uid()}.lastSeen`]: serverTs(),
            updatedAt: serverTs()
        });
    }

    function detachListener() {
        if (unsubRoom) {
            unsubRoom();
            unsubRoom = null;
        }
    }

    function attachListener(roomId) {
        detachListener();
        unsubRoom = db.collection('rooms').doc(roomId).onSnapshot(
            (snap) => {
                if (!snap.exists) {
                    roomState = null;
                    stopPresence();
                    emit('room', null);
                    emit('error', 'Room no longer exists.');
                    return;
                }
                const data = snap.data();
                const me = data.participants && data.participants[uid()];
                if (!me) {
                    roomState = null;
                    stopPresence();
                    detachListener();
                    emit('room', null);
                    emit('error', 'You were removed from the room.');
                    return;
                }

                const prevGameJson = roomState && roomState.game
                    ? JSON.stringify(roomState.game)
                    : null;
                const nextGame = data.game || null;
                const nextGameJson = nextGame ? JSON.stringify(nextGame) : null;

                roomState = {
                    roomId,
                    code: data.code,
                    hostId: data.hostId,
                    status: data.status || 'active',
                    role: me.role || 'viewer',
                    displayName: me.displayName || roomState?.displayName || 'Player',
                    participantId: uid(),
                    participants: data.participants || {},
                    game: nextGame
                };

                emit('room', getRoomSnapshot());

                if (nextGameJson && nextGameJson !== prevGameJson) {
                    applyingRemote = true;
                    try {
                        emit('game', nextGame);
                    } finally {
                        setTimeout(() => { applyingRemote = false; }, 0);
                    }
                }
            },
            (err) => {
                console.error('Room listener error', err);
                emit('error', err.message || 'Connection error');
            }
        );
    }

    async function createRoom(displayName, gameState) {
        await ensureFirebase();
        if (!initialized) throw new Error('Firebase is not configured. See ROOM_SETUP.md');

        const name = (displayName || 'Host').trim() || 'Host';
        const myUid = uid();
        let code = generateCode();
        let attempts = 0;

        while (attempts < 8) {
            const existing = await db.collection('roomCodes').doc(code).get();
            if (!existing.exists) break;
            code = generateCode();
            attempts++;
        }

        const roomRef = db.collection('rooms').doc();
        const game = sharedGameFromLocal(gameState);
        const now = serverTs();

        const participants = {
            [myUid]: {
                displayName: name,
                role: 'host',
                lastSeen: now,
                joinedAt: now
            }
        };

        const batch = db.batch();
        batch.set(roomRef, {
            code,
            hostId: myUid,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            game,
            participants
        });
        batch.set(db.collection('roomCodes').doc(code), {
            roomId: roomRef.id,
            createdAt: now
        });
        await batch.commit();

        roomState = {
            roomId: roomRef.id,
            code,
            hostId: myUid,
            status: 'active',
            role: 'host',
            displayName: name,
            participantId: myUid,
            participants,
            game
        };

        localStorage.setItem('pst_room_id', roomRef.id);
        localStorage.setItem('pst_display_name', name);

        attachListener(roomRef.id);
        startPresence();
        emit('room', getRoomSnapshot());
        return getRoomSnapshot();
    }

    async function joinRoom(code, displayName) {
        await ensureFirebase();
        if (!initialized) throw new Error('Firebase is not configured. See ROOM_SETUP.md');

        const normalized = (code || '').trim().toUpperCase();
        if (normalized.length < 4) throw new Error('Enter a valid room code');

        const name = (displayName || 'Player').trim() || 'Player';
        const codeSnap = await db.collection('roomCodes').doc(normalized).get();
        if (!codeSnap.exists) throw new Error('Room not found. Check the code and try again.');

        const roomId = codeSnap.data().roomId;
        const roomRef = db.collection('rooms').doc(roomId);
        const roomSnap = await roomRef.get();
        if (!roomSnap.exists) throw new Error('Room no longer exists.');

        const data = roomSnap.data();
        if (data.status === 'ended') throw new Error('This room has ended.');

        const myUid = uid();
        const now = serverTs();
        const existing = data.participants && data.participants[myUid];

        if (existing) {
            await roomRef.update({
                [`participants.${myUid}.displayName`]: name,
                [`participants.${myUid}.lastSeen`]: now,
                updatedAt: now
            });
        } else {
            await roomRef.update({
                [`participants.${myUid}`]: {
                    displayName: name,
                    role: 'viewer',
                    lastSeen: now,
                    joinedAt: now
                },
                updatedAt: now
            });
        }

        const role = existing ? (existing.role || 'viewer') : 'viewer';

        roomState = {
            roomId,
            code: data.code || normalized,
            hostId: data.hostId,
            status: data.status || 'active',
            role,
            displayName: name,
            participantId: myUid,
            participants: data.participants || {},
            game: data.game || null
        };

        localStorage.setItem('pst_room_id', roomId);
        localStorage.setItem('pst_display_name', name);

        attachListener(roomId);
        startPresence();
        emit('room', getRoomSnapshot());

        if (data.game) {
            applyingRemote = true;
            try {
                emit('game', data.game);
            } finally {
                setTimeout(() => { applyingRemote = false; }, 0);
            }
        }

        return getRoomSnapshot();
    }

    async function leaveRoom() {
        stopPresence();
        detachListener();
        const prev = roomState;
        roomState = null;
        localStorage.removeItem('pst_room_id');
        emit('room', null);

        if (prev && db && uid() && prev.role !== 'host') {
            try {
                await db.collection('rooms').doc(prev.roomId).update({
                    [`participants.${uid()}`]: global.firebase.firestore.FieldValue.delete(),
                    updatedAt: serverTs()
                });
            } catch (e) {
                console.warn('leaveRoom cleanup', e);
            }
        }
    }

    async function endRoom() {
        if (!roomState || !isHost()) throw new Error('Only the host can end the room');
        await db.collection('rooms').doc(roomState.roomId).update({
            status: 'ended',
            updatedAt: serverTs()
        });
        try {
            await db.collection('roomCodes').doc(roomState.code).delete();
        } catch (e) {
            console.warn('endRoom code delete', e);
        }
        roomState.status = 'ended';
        emit('room', getRoomSnapshot());
    }

    async function setParticipantRole(participantId, role) {
        if (!roomState || !isHost()) throw new Error('Only the host can change roles');
        if (!['viewer', 'editor', 'host'].includes(role)) throw new Error('Invalid role');
        if (participantId === roomState.hostId && role !== 'host') {
            throw new Error('Cannot demote the original host this way');
        }

        const updates = {
            [`participants.${participantId}.role`]: role,
            updatedAt: serverTs()
        };

        if (role === 'host') {
            updates.hostId = participantId;
            updates[`participants.${uid()}.role`] = 'editor';
        }

        await db.collection('rooms').doc(roomState.roomId).update(updates);
    }

    async function pushGameState(gameState) {
        if (!roomState || !canEdit() || applyingRemote) return;
        if (roomState.status === 'ended') return;
        if (!db) return;

        const game = sharedGameFromLocal(gameState);
        await db.collection('rooms').doc(roomState.roomId).update({
            game,
            updatedAt: serverTs()
        });
    }

    async function tryRestoreRoom() {
        if (!isConfigured()) return null;
        const roomId = localStorage.getItem('pst_room_id');
        if (!roomId) return null;
        try {
            await ensureFirebase();
            const snap = await db.collection('rooms').doc(roomId).get();
            if (!snap.exists) {
                localStorage.removeItem('pst_room_id');
                return null;
            }
            const data = snap.data();
            const me = data.participants && data.participants[uid()];
            if (!me) {
                localStorage.removeItem('pst_room_id');
                return null;
            }
            roomState = {
                roomId,
                code: data.code,
                hostId: data.hostId,
                status: data.status || 'active',
                role: me.role || 'viewer',
                displayName: me.displayName || localStorage.getItem('pst_display_name') || 'Player',
                participantId: uid(),
                participants: data.participants || {},
                game: data.game || null
            };
            attachListener(roomId);
            startPresence();
            emit('room', getRoomSnapshot());
            if (data.game) {
                applyingRemote = true;
                try {
                    emit('game', data.game);
                } finally {
                    setTimeout(() => { applyingRemote = false; }, 0);
                }
            }
            return getRoomSnapshot();
        } catch (e) {
            console.warn('tryRestoreRoom', e);
            return null;
        }
    }

    function activeParticipants(participants, nowMs) {
        const list = [];
        const now = nowMs || Date.now();
        Object.keys(participants || {}).forEach((id) => {
            const p = participants[id];
            let last = 0;
            if (p.lastSeen && typeof p.lastSeen.toMillis === 'function') {
                last = p.lastSeen.toMillis();
            } else if (p.lastSeen && p.lastSeen.seconds) {
                last = p.lastSeen.seconds * 1000;
            } else if (typeof p.lastSeen === 'string') {
                const t = Date.parse(p.lastSeen);
                if (!Number.isNaN(t)) last = t;
            }
            const online = !last || (now - last) < STALE_MS;
            list.push({
                id,
                displayName: p.displayName || 'Player',
                role: p.role || 'viewer',
                online
            });
        });
        list.sort((a, b) => {
            const order = { host: 0, editor: 1, viewer: 2 };
            return (order[a.role] ?? 9) - (order[b.role] ?? 9) ||
                a.displayName.localeCompare(b.displayName);
        });
        return list;
    }

    global.RoomSync = {
        isConfigured,
        isInRoom,
        canEdit,
        isHost,
        isApplyingRemote,
        getRoomSnapshot,
        activeParticipants,
        createRoom,
        joinRoom,
        leaveRoom,
        endRoom,
        setParticipantRole,
        pushGameState,
        tryRestoreRoom,
        on,
        STALE_MS
    };
})(window);
