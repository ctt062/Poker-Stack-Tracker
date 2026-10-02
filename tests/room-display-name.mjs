#!/usr/bin/env node
/**
 * Behavioral tests for live-room display name updates.
 * Exercises RoomSync.updateMyDisplayName against a mock Firestore.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'room.js'), 'utf8');
const SERVER_TS = { _serverTimestamp: true };

function memStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: (k) => { map.delete(k); }
    };
}

function loadRoom(options = {}) {
    const updates = [];
    const uid = options.uid || 'alice';
    const roomId = options.roomId || 'room1';
    const roomDoc = {
        code: 'ABCDE',
        hostId: uid,
        status: options.status || 'active',
        participants: {
            [uid]: {
                displayName: 'Bob',
                role: 'host',
                lastSeen: Date.now(),
                joinedAt: Date.now()
            }
        },
        game: { players: [] }
    };
    const rooms = { [roomId]: roomDoc };

    function firestore() {
        return {
            collection(name) {
                return {
                    doc(id) {
                        return {
                            async get() {
                                const data = name === 'rooms' ? rooms[id] : null;
                                return { exists: !!data, data: () => data };
                            },
                            async update(payload) {
                                updates.push({ collection: name, id, payload });
                            },
                            async delete() {
                                updates.push({ collection: name, id, payload: { _delete: true } });
                            },
                            onSnapshot() {
                                return () => {};
                            }
                        };
                    }
                };
            }
        };
    }
    firestore.FieldValue = {
        serverTimestamp: () => SERVER_TS,
        delete: () => ({ _delete: true })
    };

    const sandbox = {
        console,
        crypto: globalThis.crypto,
        setTimeout,
        clearTimeout,
        setInterval() { return 0; },
        clearInterval() {},
        localStorage: memStorage(),
        FIREBASE_CONFIG: { apiKey: 'test', projectId: 'p', appId: 'a' },
        firebase: {
            apps: [{}],
            initializeApp() {},
            auth() {
                return { currentUser: { uid, isAnonymous: false } };
            },
            firestore
        },
        document: {
            createElement() { return {}; },
            head: { appendChild() {} }
        }
    };
    sandbox.window = sandbox;
    sandbox.AppAuth = {
        async ensureAuth() { return { signedIn: true, uid }; },
        getDisplayName() { return 'Bob'; }
    };
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    sandbox.localStorage.setItem('pst_room_id', roomId);
    return { RoomSync: sandbox.RoomSync, updates, uid, roomId };
}

const failures = [];
function ok(name, cond, extra) {
    if (cond) console.log('PASS', name);
    else {
        const msg = extra ? `${name}: ${extra}` : name;
        console.error('FAIL', msg);
        failures.push(msg);
    }
}

async function run() {
    {
        const { RoomSync, updates } = loadRoom();
        const before = await RoomSync.updateMyDisplayName('Robert');
        ok(
            'not in a room does not write',
            before == null && updates.length === 0,
            JSON.stringify({ before, updates })
        );
    }

    {
        const { RoomSync, updates, uid, roomId } = loadRoom();
        const restored = await RoomSync.tryRestoreRoom();
        ok(
            'restored live room as Bob',
            !!(restored && restored.roomId === roomId && restored.displayName === 'Bob'),
            JSON.stringify(restored)
        );
        updates.length = 0;
        const roomEvents = [];
        RoomSync.on('room', (snap) => roomEvents.push(snap));
        const snap = await RoomSync.updateMyDisplayName('Robert');
        const write = updates.find((u) => u.collection === 'rooms' && u.id === roomId);
        const payload = write && write.payload;
        ok(
            'live room writes participant displayName',
            !!(payload && payload[`participants.${uid}.displayName`] === 'Robert'),
            JSON.stringify(payload)
        );
        ok(
            'live room keeps presence lastSeen',
            !!(payload && payload[`participants.${uid}.lastSeen`] === SERVER_TS),
            JSON.stringify(payload)
        );
        ok(
            'live room keeps updatedAt',
            !!(payload && payload.updatedAt === SERVER_TS),
            JSON.stringify(payload)
        );
        ok(
            'joined-as identity uses claimed name',
            !!(snap && snap.displayName === 'Robert'),
            snap && snap.displayName
        );
        ok(
            'people/seat identity uses claimed name',
            !!(snap && snap.participants[uid] && snap.participants[uid].displayName === 'Robert'),
            JSON.stringify(snap && snap.participants)
        );
        const people = RoomSync.activeParticipants(snap.participants);
        ok(
            'active participants list uses claimed name',
            people.some((p) => p.id === uid && p.displayName === 'Robert'),
            JSON.stringify(people)
        );
        ok(
            'room listeners see the claimed name',
            roomEvents.some((s) => s && s.displayName === 'Robert'),
            String(roomEvents.length)
        );
        const taken = Object.keys(snap.participants).some((id) => {
            if (id === uid) return false;
            return (snap.participants[id].displayName || '').trim().toLowerCase() === 'bob';
        });
        ok(
            'old name is free for another joiner in this room',
            snap.participants[uid].displayName !== 'Bob' && taken === false,
            snap.participants[uid].displayName
        );
    }

    {
        const { RoomSync, updates } = loadRoom({ status: 'ended' });
        const restored = await RoomSync.tryRestoreRoom();
        ok('ended room is not restored', restored == null, JSON.stringify(restored));
        updates.length = 0;
        const result = await RoomSync.updateMyDisplayName('Robert');
        ok(
            'ended unrestored room does not write',
            result == null && updates.length === 0,
            JSON.stringify({ result, updates })
        );
    }

    {
        const { RoomSync, updates, uid } = loadRoom();
        await RoomSync.tryRestoreRoom();
        await RoomSync.endRoom();
        updates.length = 0;
        const result = await RoomSync.updateMyDisplayName('Robert');
        const renamed = updates.some((u) => u.payload && u.payload[`participants.${uid}.displayName`]);
        ok(
            'ended live session does not rename',
            result == null && !renamed,
            JSON.stringify({ result, updates })
        );
    }

    {
        const { RoomSync, updates } = loadRoom();
        await RoomSync.tryRestoreRoom();
        updates.length = 0;
        let err = null;
        try {
            await RoomSync.updateMyDisplayName('   ');
        } catch (e) {
            err = e;
        }
        ok(
            'empty name is rejected in a live room',
            !!(err && /display name/i.test(err.message)) && updates.length === 0,
            err && err.message
        );
    }

    if (failures.length) {
        console.error(`\n${failures.length} failed`);
        process.exit(1);
    }
    console.log('\nALL PASSED');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
