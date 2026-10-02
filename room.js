/**
 * Room sync layer: multi-device shared session via Firebase Auth + Firestore.
 * Sign-in is Google / Apple / email (see auth.js). Anonymous auth is not used.
 * If Firebase is not configured, create/join is disabled and the app stays local-only.
 */
(function (global) {
    'use strict';

    const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
    const CODE_LENGTH = 5;
    const CODE_ATTEMPTS = 8;
    const PRESENCE_MS = 20000;
    const STALE_MS = 60000;
    /** How long a kicked player cannot rejoin the same room. */
    const KICK_BAN_MS = 5 * 60 * 1000;
    /** Empty rooms are deleted this long after the last person leaves. */
    const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
    const ABANDON_CLEANUP_KEY = 'pst_abandon_cleanup';
    const SDK_VERSION = '10.14.1';
    const SDK_SCRIPTS = [
        'firebase-app-compat.js',
        'firebase-auth-compat.js',
        'firebase-firestore-compat.js'
    ];

    let auth = null;
    let db = null;
    let unsubRoom = null;
    let presenceTimer = null;
    let applyingRemote = false;
    let initialized = false;
    let sdkPromise = null;
    // Local game push sequencing: ignore older snapshots while a newer local
    // write is in flight (same-device echo / out-of-order). Multi-device LWW
    // still applies once pushes drain.
    let localPushEpoch = 0;
    let confirmedPushEpoch = 0;
    let pushSessionId = 0;
    let pendingPushGame = null;
    let pushChain = Promise.resolve();

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
        return JSON.parse(JSON.stringify({
            blindStructure: gameState.blindStructure,
            stackAmount: gameState.stackAmount,
            players: gameState.players,
            sessionName: gameState.sessionName,
            bankerName: gameState.bankerName,
            rake: gameState.rake || null,
            house: gameState.house || null,
            clock: gameState.clock || null
        }));
    }

    /** Require a non-empty display name (no silent defaults). */
    function requireDisplayName(displayName) {
        const name = (displayName == null ? '' : String(displayName)).trim();
        if (!name) throw new Error('Enter a display name');
        if (name.length > 32) throw new Error('Display name must be 32 characters or fewer');
        return name;
    }

    /**
     * True if another participant already uses this name (case-insensitive).
     * exceptUid is ignored so a rejoining user can keep their own name.
     */
    function isDisplayNameTaken(participants, name, exceptUid) {
        const target = name.trim().toLowerCase();
        if (!target) return false;
        const map = participants || {};
        return Object.keys(map).some((id) => {
            if (exceptUid && id === exceptUid) return false;
            const other = (map[id].displayName || '').trim().toLowerCase();
            return other === target;
        });
    }

    function banUntilMs(ban) {
        if (!ban) return 0;
        if (typeof ban.until === 'number') return ban.until;
        if (ban.until && typeof ban.until.toMillis === 'function') return ban.until.toMillis();
        if (ban.until && typeof ban.until.seconds === 'number') return ban.until.seconds * 1000;
        return 0;
    }

    function formatBanRemaining(ban) {
        const ms = Math.max(0, banUntilMs(ban) - Date.now());
        const mins = Math.max(1, Math.ceil(ms / 60000));
        return mins === 1 ? 'about 1 minute' : `${mins} minutes`;
    }

    /**
     * Active kick ban for this user id and/or display name (case-insensitive).
     * Name match blocks rejoining with the same nickname after a kick.
     */
    function getActiveBan(bans, userId, displayName) {
        const map = bans || {};
        const now = Date.now();
        const byUid = userId ? map[userId] : null;
        if (byUid && banUntilMs(byUid) > now) return byUid;

        const target = (displayName || '').trim().toLowerCase();
        if (!target) return null;
        const ids = Object.keys(map);
        for (let i = 0; i < ids.length; i++) {
            const ban = map[ids[i]];
            if (banUntilMs(ban) <= now) continue;
            if ((ban.displayName || '').trim().toLowerCase() === target) return ban;
        }
        return null;
    }

    function serverTs() {
        return global.firebase.firestore.FieldValue.serverTimestamp();
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.async = false;
            el.onload = () => resolve();
            el.onerror = () => {
                console.error('Failed to load script', src);
                reject(new Error('Could not reach Firebase. Check your connection and try again.'));
            };
            document.head.appendChild(el);
        });
    }

    /**
     * Prefer auth.js's SDK loader so sign-in and rooms share one Firebase app.
     */
    function loadFirebaseSdk() {
        if (global.AppAuth && typeof global.AppAuth.loadSdk === 'function') {
            return global.AppAuth.loadSdk();
        }
        if (global.firebase && global.firebase.firestore && global.firebase.auth) {
            return Promise.resolve();
        }
        if (!sdkPromise) {
            sdkPromise = SDK_SCRIPTS.reduce(
                (chain, file) => chain.then(() =>
                    loadScript(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/${file}`)),
                Promise.resolve()
            ).catch((e) => {
                sdkPromise = null;
                throw e;
            });
        }
        return sdkPromise;
    }

    async function ensureFirebase() {
        if (initialized) return true;
        if (!isConfigured()) return false;

        if (global.AppAuth && typeof global.AppAuth.ensureAuth === 'function') {
            await global.AppAuth.ensureAuth();
        } else {
            await loadFirebaseSdk();
            if (!global.firebase) {
                throw new Error('Firebase SDK not loaded');
            }
            if (!global.firebase.apps.length) {
                global.firebase.initializeApp(global.FIREBASE_CONFIG);
            }
        }

        auth = global.firebase.auth();
        db = global.firebase.firestore();

        if (!auth.currentUser || auth.currentUser.isAnonymous) {
            throw new Error('Sign in with Google, Apple, or email first.');
        }

        initialized = true;
        // Best-effort purge of rooms we abandoned earlier (10 min TTL)
        runPendingAbandonCleanup().catch(() => {});
        return true;
    }

    function uid() {
        return auth && auth.currentUser ? auth.currentUser.uid : null;
    }

    function canEdit() {
        if (!roomState) return true; // solo mode
        if (roomState.status === 'ended' || roomState.status === 'abandoned') return false;
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

    function setRoomStateFromDoc(roomId, data, overrides) {
        const me = (data.participants && data.participants[uid()]) || {};
        roomState = Object.assign({
            roomId,
            code: data.code,
            hostId: data.hostId,
            status: data.status || 'active',
            role: me.role || 'viewer',
            displayName: me.displayName
                || (roomState && roomState.displayName)
                || 'Player',
            participantId: uid(),
            participants: data.participants || {},
            game: data.game || null
        }, overrides || {});
        return roomState;
    }

    function applyRemote(game) {
        if (!game) return;
        applyingRemote = true;
        try {
            emit('game', game);
        } finally {
            setTimeout(() => { applyingRemote = false; }, 0);
        }
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

    function resetPushState() {
        pushSessionId += 1;
        localPushEpoch = 0;
        confirmedPushEpoch = 0;
        pendingPushGame = null;
    }

    function attachListener(roomId) {
        detachListener();
        unsubRoom = db.collection('rooms').doc(roomId).onSnapshot(
            (snap) => {
                if (!snap.exists) {
                    roomState = null;
                    stopPresence();
                    detachListener();
                    resetPushState();
                    emit('room', null);
                    emit('error', 'Room no longer exists.');
                    return;
                }
                const data = snap.data();
                const me = data.participants && data.participants[uid()];
                if (!me) {
                    const ban = getActiveBan(data.bans, uid(), null);
                    const kickMsg = ban
                        ? `You were kicked from the room. You can rejoin after ${formatBanRemaining(ban)}.`
                        : 'You were removed from the room.';
                    roomState = null;
                    stopPresence();
                    detachListener();
                    resetPushState();
                    localStorage.removeItem('pst_room_id');
                    emit('room', null);
                    emit('error', kickMsg);
                    return;
                }

                const prevGame = roomState && roomState.game ? roomState.game : null;
                const prevGameJson = prevGame ? JSON.stringify(prevGame) : null;
                const nextGame = data.game || null;
                const nextGameJson = nextGame ? JSON.stringify(nextGame) : null;
                const gameChanged = !!(nextGameJson && nextGameJson !== prevGameJson);
                // Protect newer local edits from an older in-flight snapshot echo.
                const skipStaleRemote = gameChanged && localPushEpoch > confirmedPushEpoch;

                setRoomStateFromDoc(roomId, data);
                if (skipStaleRemote && roomState) {
                    roomState.game = prevGame;
                }
                emit('room', getRoomSnapshot());

                if (gameChanged && !skipStaleRemote) {
                    applyRemote(nextGame);
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

        const name = requireDisplayName(displayName);
        const myUid = uid();
        let code = null;

        for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
            const candidate = generateCode();
            const existing = await db.collection('roomCodes').doc(candidate).get();
            if (!existing.exists) {
                code = candidate;
                break;
            }
        }
        if (!code) throw new Error('Could not allocate a room code. Please try again.');

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

        setRoomStateFromDoc(roomRef.id, {
            code,
            hostId: myUid,
            status: 'active',
            participants,
            game
        }, { displayName: name });

        localStorage.setItem('pst_room_id', roomRef.id);
        localStorage.setItem('pst_display_name', name);
        if (global.AppAuth && typeof global.AppAuth.setDisplayName === 'function') {
            global.AppAuth.setDisplayName(name).catch(() => {});
        }

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

        const name = requireDisplayName(displayName);
        const codeSnap = await db.collection('roomCodes').doc(normalized).get();
        if (!codeSnap.exists) throw new Error('Room not found. Check the code and try again.');

        const roomId = codeSnap.data().roomId;
        const roomRef = db.collection('rooms').doc(roomId);
        const roomSnap = await roomRef.get();
        if (!roomSnap.exists) throw new Error('Room no longer exists.');

        const data = roomSnap.data();
        if (data.status === 'ended') throw new Error('This room has ended.');
        if (data.status === 'abandoned') {
            throw new Error('This room is closed (everyone left).');
        }
        if (data.status && data.status !== 'active') {
            throw new Error('This room is not available to join.');
        }

        const myUid = uid();
        const now = serverTs();
        const existing = data.participants && data.participants[myUid];

        const ban = getActiveBan(data.bans, myUid, name);
        if (ban) {
            throw new Error(
                `You cannot rejoin this room yet (kicked). Try again in ${formatBanRemaining(ban)}.`
            );
        }

        if (isDisplayNameTaken(data.participants, name, myUid)) {
            throw new Error('That display name is already taken in this room. Choose another.');
        }

        try {
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
        } catch (err) {
            const code = err && (err.code || err.message || '');
            if (String(code).includes('permission') || String(code).includes('Permission')) {
                throw new Error(
                    'Could not join (permission denied). The room may have closed, you may be kick-banned, or rules need a refresh. Try again in a moment.'
                );
            }
            throw err;
        }

        // Re-read so host transfer / game state is fresh after join
        const joinedSnap = await roomRef.get();
        const joinedData = joinedSnap.exists ? joinedSnap.data() : data;
        const me = joinedData.participants && joinedData.participants[myUid];
        const role = (me && me.role) || (existing ? (existing.role || 'viewer') : 'viewer');

        setRoomStateFromDoc(roomId, joinedData, {
            code: joinedData.code || normalized,
            role,
            displayName: name
        });

        localStorage.setItem('pst_room_id', roomId);
        localStorage.setItem('pst_display_name', name);
        if (global.AppAuth && typeof global.AppAuth.setDisplayName === 'function') {
            global.AppAuth.setDisplayName(name).catch(() => {});
        }

        attachListener(roomId);
        startPresence();
        emit('room', getRoomSnapshot());
        applyRemote(joinedData.game);

        return getRoomSnapshot();
    }

    function participantJoinedAtMs(p) {
        if (!p || p.joinedAt == null) return Number.MAX_SAFE_INTEGER;
        if (typeof p.joinedAt.toMillis === 'function') return p.joinedAt.toMillis();
        if (typeof p.joinedAt.seconds === 'number') return p.joinedAt.seconds * 1000;
        if (typeof p.joinedAt === 'number') return p.joinedAt;
        const t = Date.parse(p.joinedAt);
        return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
    }

    /** Earliest joiner among remaining participants (stable order for host handoff). */
    function pickNextHost(participants, excludeUid) {
        const ids = Object.keys(participants || {}).filter((id) => id !== excludeUid);
        if (ids.length === 0) return null;
        ids.sort((a, b) => {
            const ja = participantJoinedAtMs(participants[a]);
            const jb = participantJoinedAtMs(participants[b]);
            return ja - jb || a.localeCompare(b);
        });
        return { id: ids[0], participant: participants[ids[0]] };
    }

    async function deleteRoomCode(code) {
        if (!code || !db) return;
        try {
            await db.collection('roomCodes').doc(code).delete();
        } catch (e) {
            console.warn('deleteRoomCode', e);
        }
    }

    function scheduleAbandonCleanup(roomId, emptyAt) {
        if (!roomId) return;
        try {
            localStorage.setItem(ABANDON_CLEANUP_KEY, JSON.stringify({ roomId, emptyAt }));
        } catch (e) { /* ignore */ }
        const delay = Math.max(1000, emptyAt + EMPTY_ROOM_TTL_MS - Date.now() + 500);
        setTimeout(() => {
            purgeAbandonedRoom(roomId, emptyAt).catch(() => {});
        }, delay);
    }

    async function purgeAbandonedRoom(roomId, expectedEmptyAt) {
        if (!roomId || !isConfigured()) return;
        try {
            await ensureFirebase();
            if (!db) return;
            const snap = await db.collection('rooms').doc(roomId).get();
            if (!snap.exists) {
                clearAbandonCleanup(roomId);
                return;
            }
            const data = snap.data();
            if (data.status !== 'abandoned') {
                clearAbandonCleanup(roomId);
                return;
            }
            const emptyAt = typeof data.emptyAt === 'number' ? data.emptyAt : expectedEmptyAt;
            if (Date.now() < emptyAt + EMPTY_ROOM_TTL_MS) {
                scheduleAbandonCleanup(roomId, emptyAt);
                return;
            }
            await db.collection('rooms').doc(roomId).delete();
            if (data.code) await deleteRoomCode(data.code);
            clearAbandonCleanup(roomId);
        } catch (e) {
            console.warn('purgeAbandonedRoom', e);
        }
    }

    function clearAbandonCleanup(roomId) {
        try {
            const raw = localStorage.getItem(ABANDON_CLEANUP_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!roomId || parsed.roomId === roomId) {
                localStorage.removeItem(ABANDON_CLEANUP_KEY);
            }
        } catch (e) {
            localStorage.removeItem(ABANDON_CLEANUP_KEY);
        }
    }

    async function runPendingAbandonCleanup() {
        try {
            const raw = localStorage.getItem(ABANDON_CLEANUP_KEY);
            if (!raw) return;
            const { roomId, emptyAt } = JSON.parse(raw);
            if (roomId) await purgeAbandonedRoom(roomId, emptyAt || 0);
        } catch (e) {
            console.warn('runPendingAbandonCleanup', e);
        }
    }

    /**
     * Apply leave against a fresh room snapshot: transfer host if needed,
     * or abandon the room when the last person leaves.
     */
    async function performLeave(prev) {
        if (!prev || !db || !uid()) return;
        const roomRef = db.collection('rooms').doc(prev.roomId);
        const snap = await roomRef.get();
        if (!snap.exists) return;

        const data = snap.data();
        const participants = Object.assign({}, data.participants || {});
        const myUid = uid();
        if (!(myUid in participants)) return;

        const others = Object.keys(participants).filter((id) => id !== myUid);

        // Last person out: close the session; delete after EMPTY_ROOM_TTL_MS
        if (others.length === 0) {
            const emptyAt = Date.now();
            await roomRef.update({
                status: 'abandoned',
                emptyAt,
                participants: {},
                updatedAt: serverTs()
            });
            await deleteRoomCode(data.code || prev.code);
            scheduleAbandonCleanup(prev.roomId, emptyAt);
            return;
        }

        // Host leaves while others remain: hand host to earliest joiner
        if (data.hostId === myUid || (participants[myUid] && participants[myUid].role === 'host')) {
            const next = pickNextHost(participants, myUid);
            if (!next) {
                const emptyAt = Date.now();
                await roomRef.update({
                    status: 'abandoned',
                    emptyAt,
                    participants: {},
                    updatedAt: serverTs()
                });
                await deleteRoomCode(data.code || prev.code);
                scheduleAbandonCleanup(prev.roomId, emptyAt);
                return;
            }
            await roomRef.update({
                hostId: next.id,
                [`participants.${next.id}.role`]: 'host',
                [`participants.${myUid}`]: global.firebase.firestore.FieldValue.delete(),
                updatedAt: serverTs()
            });
            return;
        }

        // Regular guest leave
        await roomRef.update({
            [`participants.${myUid}`]: global.firebase.firestore.FieldValue.delete(),
            updatedAt: serverTs()
        });
    }

    async function leaveRoom() {
        stopPresence();
        detachListener();
        const prev = roomState;
        roomState = null;
        resetPushState();
        localStorage.removeItem('pst_room_id');
        emit('room', null);

        if (!prev || !db || !uid()) return;
        try {
            await performLeave(prev);
        } catch (e) {
            console.warn('leaveRoom cleanup', e);
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

    /**
     * Host removes a participant and bans them from rejoining for KICK_BAN_MS.
     * Ban is keyed by auth uid and stores display name for join-time checks.
     */
    async function kickParticipant(participantId) {
        if (!roomState || !isHost()) throw new Error('Only the host can kick people');
        if (!participantId) throw new Error('No participant selected');
        if (participantId === roomState.hostId || participantId === uid()) {
            throw new Error('Cannot kick the host');
        }
        const person = roomState.participants && roomState.participants[participantId];
        if (!person) throw new Error('That person is not in the room');
        if (!db) throw new Error('Not connected');

        const until = Date.now() + KICK_BAN_MS;
        await db.collection('rooms').doc(roomState.roomId).update({
            [`participants.${participantId}`]: global.firebase.firestore.FieldValue.delete(),
            [`bans.${participantId}`]: {
                until,
                displayName: person.displayName || 'Player'
            },
            updatedAt: serverTs()
        });
    }

    async function pushGameState(gameState) {
        if (!roomState || !canEdit() || applyingRemote) return;
        if (roomState.status === 'ended' || roomState.status === 'abandoned') return;
        if (!db) return;

        pendingPushGame = sharedGameFromLocal(gameState);
        localPushEpoch += 1;
        const sessionAtEnqueue = pushSessionId;

        const run = async () => {
            while (
                pendingPushGame
                && roomState
                && roomState.status !== 'ended'
                && roomState.status !== 'abandoned'
                && db
                && sessionAtEnqueue === pushSessionId
            ) {
                const game = pendingPushGame;
                const epoch = localPushEpoch;
                const roomId = roomState.roomId;
                pendingPushGame = null;
                try {
                    await db.collection('rooms').doc(roomId).update({
                        game,
                        updatedAt: serverTs()
                    });
                } catch (err) {
                    if (sessionAtEnqueue !== pushSessionId) throw err;
                    if (!pendingPushGame) {
                        pendingPushGame = game;
                    } else if (pendingPushGame !== game) {
                        continue;
                    }
                    throw err;
                }
                if (sessionAtEnqueue !== pushSessionId) return;
                if (roomState && roomState.roomId === roomId) {
                    roomState.game = game;
                }
                confirmedPushEpoch = epoch;
            }
        };

        const result = pushChain.then(run, run);
        pushChain = result.catch(() => {});
        return result;
    }

    async function tryRestoreRoom() {
        if (!isConfigured()) return null;
        await runPendingAbandonCleanup();
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
            if (data.status === 'abandoned') {
                localStorage.removeItem('pst_room_id');
                await purgeAbandonedRoom(roomId, data.emptyAt || 0);
                return null;
            }
            if (data.status === 'ended') {
                localStorage.removeItem('pst_room_id');
                return null;
            }
            const me = data.participants && data.participants[uid()];
            if (!me) {
                localStorage.removeItem('pst_room_id');
                return null;
            }
            setRoomStateFromDoc(roomId, data, {
                displayName: me.displayName
                    || localStorage.getItem('pst_display_name')
                    || 'Player'
            });
            attachListener(roomId);
            startPresence();
            emit('room', getRoomSnapshot());
            applyRemote(data.game);
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
        kickParticipant,
        pushGameState,
        tryRestoreRoom,
        on,
        STALE_MS,
        KICK_BAN_MS
    };
})(window);
