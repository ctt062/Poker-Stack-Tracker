#!/usr/bin/env node
/**
 * Room create cap (3 per account) and 1-week expiry.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'room.js'), 'utf8');
const SERVER_TS = { _serverTimestamp: true };
const DELETE_SENTINEL = { _delete: true };

function memStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: (k) => { map.delete(k); }
    };
}

function applyUpdate(target, payload) {
    Object.keys(payload).forEach((key) => {
        const value = payload[key];
        if (key.indexOf('.') === -1) {
            if (value === DELETE_SENTINEL) delete target[key];
            else target[key] = value;
            return;
        }
        const parts = key.split('.');
        let cur = target;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
            cur = cur[parts[i]];
        }
        const last = parts[parts.length - 1];
        if (value === DELETE_SENTINEL) delete cur[last];
        else cur[last] = value;
    });
}

function loadRoom(options = {}) {
    const uid = options.uid || 'alice';
    const rooms = options.rooms || {};
    const roomCodes = options.roomCodes || {};
    const users = options.users || { [uid]: { uid, createdRooms: {} } };
    let seq = 0;
    const writes = [];

    function docRef(name, id) {
        const store = name === 'rooms' ? rooms
            : name === 'roomCodes' ? roomCodes
                : name === 'users' ? users
                    : {};
        return {
            id,
            async get() {
                const data = store[id];
                return {
                    exists: data != null,
                    data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data)))
                };
            },
            async set(payload, opts) {
                writes.push({ op: 'set', collection: name, id, payload });
                const copy = JSON.parse(JSON.stringify(payload));
                if (opts && opts.merge && store[id]) {
                    store[id] = Object.assign({}, store[id], copy);
                } else {
                    store[id] = copy;
                }
            },
            async update(payload) {
                writes.push({ op: 'update', collection: name, id, payload });
                if (!store[id]) store[id] = {};
                applyUpdate(store[id], payload);
            },
            async delete() {
                writes.push({ op: 'delete', collection: name, id });
                delete store[id];
            },
            onSnapshot() {
                return () => {};
            }
        };
    }

    function firestore() {
        return {
            collection(name) {
                return {
                    doc(id) {
                        const docId = arguments.length ? id : `gen_${++seq}`;
                        return docRef(name, docId);
                    }
                };
            },
            async runTransaction(fn) {
                const tx = {
                    get: (ref) => ref.get(),
                    set: (ref, data, opts) => ref.set(data, opts),
                    update: (ref, data) => ref.update(data),
                    delete: (ref) => ref.delete()
                };
                return fn(tx);
            }
        };
    }
    firestore.FieldValue = {
        serverTimestamp: () => SERVER_TS,
        delete: () => DELETE_SENTINEL
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
        getDisplayName() { return options.displayName || 'River'; }
    };
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return {
        RoomSync: sandbox.RoomSync,
        writes,
        rooms,
        roomCodes,
        users,
        uid,
        storage: sandbox.localStorage
    };
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

function liveRoom(uid, code) {
    return {
        code,
        hostId: uid,
        createdBy: uid,
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
        participants: {
            [uid]: { displayName: 'River', role: 'host', lastSeen: Date.now(), joinedAt: Date.now() }
        },
        game: { players: [] }
    };
}

async function run() {
    {
        const { RoomSync, rooms, users, uid } = loadRoom();
        const snap = await RoomSync.createRoom('River', { players: [], stackAmount: 200 });
        ok('create room returns snapshot', !!(snap && snap.roomId && snap.code), JSON.stringify(snap));
        const created = rooms[snap.roomId];
        ok(
            'create room stores createdBy and expiresAt',
            !!(created && created.createdBy === uid && created.expiresAt),
            JSON.stringify(created)
        );
        ok(
            'create room records the id on the user',
            !!(users[uid] && users[uid].createdRooms && users[uid].createdRooms[snap.roomId] === true),
            JSON.stringify(users[uid])
        );
        const ttl = created.expiresAt instanceof Date
            ? created.expiresAt.getTime()
            : Date.parse(created.expiresAt);
        const delta = ttl - Date.now();
        ok(
            'expiry is about one week',
            delta > 6 * 24 * 60 * 60 * 1000 && delta < 8 * 24 * 60 * 60 * 1000,
            String(delta)
        );
    }

    {
        const uid = 'alice';
        const rooms = {
            r1: liveRoom(uid, 'AAAAA'),
            r2: liveRoom(uid, 'BBBBB'),
            r3: liveRoom(uid, 'CCCCC')
        };
        const { RoomSync } = loadRoom({
            uid,
            rooms,
            roomCodes: {
                AAAAA: { roomId: 'r1' },
                BBBBB: { roomId: 'r2' },
                CCCCC: { roomId: 'r3' }
            },
            users: { [uid]: { uid, createdRooms: { r1: true, r2: true, r3: true } } }
        });
        let err = null;
        try {
            await RoomSync.createRoom('River', { players: [] });
        } catch (e) {
            err = e;
        }
        ok(
            'fourth live room is rejected',
            !!(err && /at most 3 rooms/i.test(err.message)),
            err && err.message
        );
    }

    {
        const uid = 'alice';
        const rooms = {
            r1: liveRoom(uid, 'AAAAA'),
            r2: Object.assign(liveRoom(uid, 'BBBBB'), { expiresAt: Date.now() - 1000 }),
            r3: Object.assign(liveRoom(uid, 'CCCCC'), { status: 'ended' })
        };
        const { RoomSync, rooms: after, users } = loadRoom({
            uid,
            rooms,
            roomCodes: {
                AAAAA: { roomId: 'r1' },
                BBBBB: { roomId: 'r2' },
                CCCCC: { roomId: 'r3' }
            },
            users: { [uid]: { uid, createdRooms: { r1: true, r2: true, r3: true } } }
        });
        const snap = await RoomSync.createRoom('River', { players: [] });
        ok('create allowed after sweeping expired and ended rooms', !!(snap && snap.roomId), JSON.stringify(snap));
        ok('expired room deleted during create', after.r2 == null, JSON.stringify(Object.keys(after)));
        ok('ended room is kept but does not count', after.r3 != null, JSON.stringify(Object.keys(after)));
        ok(
            'createdRooms keeps only live rooms plus the new one',
            !!(users[uid].createdRooms.r1 && users[uid].createdRooms[snap.roomId] && !users[uid].createdRooms.r2 && !users[uid].createdRooms.r3),
            JSON.stringify(users[uid].createdRooms)
        );
    }

    {
        const uid = 'alice';
        const rooms = {
            old: Object.assign(liveRoom(uid, 'OLD12'), { expiresAt: Date.now() - 50 })
        };
        const { RoomSync, rooms: after, roomCodes } = loadRoom({
            uid,
            rooms,
            roomCodes: { OLD12: { roomId: 'old' } }
        });
        let err = null;
        try {
            await RoomSync.joinRoom('OLD12', 'River');
        } catch (e) {
            err = e;
        }
        ok(
            'joining an expired room is rejected',
            !!(err && /expired/i.test(err.message)),
            err && err.message
        );
        ok('joining an expired room deletes it', after.old == null, JSON.stringify(after));
        ok('joining an expired room deletes the code', roomCodes.OLD12 == null, JSON.stringify(roomCodes));
    }

    {
        const uid = 'alice';
        const rooms = {
            old: Object.assign(liveRoom(uid, 'OLD12'), { expiresAt: Date.now() - 50 })
        };
        const { RoomSync, storage, rooms: after } = loadRoom({
            uid,
            rooms,
            roomCodes: { OLD12: { roomId: 'old' } }
        });
        storage.setItem('pst_room_id', 'old');
        const restored = await RoomSync.tryRestoreRoom();
        ok('expired room is not restored', restored == null, JSON.stringify(restored));
        ok('expired restore deletes the room', after.old == null, JSON.stringify(after));
        ok('expired restore clears local room id', storage.getItem('pst_room_id') == null);
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
