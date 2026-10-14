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
    const snapshotCbs = new Map();

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
            onSnapshot(onNext) {
                const key = name + ':' + id;
                snapshotCbs.set(key, onNext);
                return () => {
                    if (snapshotCbs.get(key) === onNext) snapshotCbs.delete(key);
                };
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
                return {
                    currentUser: {
                        uid,
                        isAnonymous: false,
                        emailVerified: options.emailVerified !== false,
                        providerData: options.providerData || [{ providerId: 'password' }]
                    }
                };
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
        async ensureAuth() {
            if (options.ensureAuthFails) throw new Error('offline');
            return { signedIn: true, uid };
        },
        getDisplayName() { return options.displayName || 'River'; }
    };
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    function fireDocSnapshot(collection, docId) {
        const cb = snapshotCbs.get(collection + ':' + docId);
        if (!cb) return false;
        const store = collection === 'rooms' ? rooms
            : collection === 'roomCodes' ? roomCodes
                : users;
        const data = store[docId];
        cb({
            exists: data != null,
            data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data)))
        });
        return true;
    }

    return {
        RoomSync: sandbox.RoomSync,
        writes,
        rooms,
        roomCodes,
        users,
        uid,
        storage: sandbox.localStorage,
        fireDocSnapshot
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

function endedRoom(uid, code) {
    return Object.assign(liveRoom(uid, code), {
        status: 'ended',
        expiresAt: Date.now()
    });
}

async function run() {
    {
        const { RoomSync } = loadRoom({ emailVerified: false });
        let err = null;
        try {
            await RoomSync.createRoom('River', { players: [] });
        } catch (e) {
            err = e;
        }
        ok(
            'unverified email cannot create a room',
            !!(err && /verify your email/i.test(String(err.message || ''))),
            String((err && err.message) || err)
        );
    }

    {
        const { RoomSync, rooms } = loadRoom({
            emailVerified: false,
            providerData: [{ providerId: 'google.com' }]
        });
        const snap = await RoomSync.createRoom('River', { players: [], stackAmount: 200 });
        ok(
            'Google can create a room without a password verification step',
            !!(snap && snap.roomId && rooms[snap.roomId]),
            JSON.stringify(snap)
        );
    }

    {
        const { RoomSync, rooms, users, uid } = loadRoom();
        const snap = await RoomSync.createRoom('River', { players: [], stackAmount: 200 });
        ok('create room returns snapshot', !!(snap && snap.roomId && snap.code), JSON.stringify(snap));
        ok('create room uses a 4-digit code', /^\d{4}$/.test(snap.code), snap.code);
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
        ok(
            'create room records joinedRooms for the host',
            !!(users[uid] && users[uid].joinedRooms && users[uid].joinedRooms[snap.roomId] === true),
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
        const rooms = { r1: liveRoom('host', '0421') };
        const { RoomSync, users } = loadRoom({
            uid: 'bob',
            rooms,
            roomCodes: { '0421': { roomId: 'r1' } },
            users: { bob: { uid: 'bob', createdRooms: {} } }
        });
        const snap = await RoomSync.joinRoom(' 0421 ', 'Bob');
        ok(
            'join accepts a 4-digit code',
            !!(snap && snap.roomId === 'r1' && snap.code === '0421'),
            JSON.stringify(snap)
        );
        ok(
            'join records joinedRooms on the user',
            !!(users.bob && users.bob.joinedRooms && users.bob.joinedRooms.r1 === true),
            JSON.stringify(users.bob)
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
            r3: endedRoom(uid, 'CCCCC')
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

    {
        const uid = 'alice';
        const rooms = {
            done: endedRoom(uid, 'END1')
        };
        const { RoomSync, storage, rooms: after } = loadRoom({
            uid,
            rooms,
            roomCodes: { END1: { roomId: 'done' } },
            users: { [uid]: { uid, createdRooms: { done: true }, joinedRooms: { done: true } } }
        });
        storage.setItem('pst_room_id', 'done');
        const restored = await RoomSync.tryRestoreRoom();
        ok(
            'ended restore signals ended without attaching',
            !!(restored && restored.restore === 'ended' && !restored.roomId),
            JSON.stringify(restored)
        );
        ok('ended restore keeps the room doc', after.done != null && after.done.status === 'ended');
        ok('ended restore clears local room id', storage.getItem('pst_room_id') == null);
        await new Promise((r) => setTimeout(r, 0));
        ok(
            'ended restore still keeps the room doc after sweep',
            after.done != null && after.done.status === 'ended',
            JSON.stringify(after.done)
        );
    }

    {
        const uid = 'alice';
        const rooms = {
            done: endedRoom(uid, 'END1')
        };
        const { RoomSync, rooms: after, roomCodes } = loadRoom({
            uid,
            rooms,
            roomCodes: { END1: { roomId: 'done' } }
        });
        let err = null;
        try {
            await RoomSync.joinRoom('END1', 'River');
        } catch (e) {
            err = e;
        }
        ok(
            'joining an ended room is rejected as ended',
            !!(err && /ended/i.test(err.message) && !/expired/i.test(err.message)),
            err && err.message
        );
        ok('joining an ended room does not purge it', after.done != null && after.done.status === 'ended');
        ok('joining an ended room does not delete the leftover code', roomCodes.END1 != null);
    }

    {
        const uid = 'alice';
        const rooms = {
            done: endedRoom(uid, 'END1')
        };
        const { RoomSync, rooms: after, users } = loadRoom({
            uid,
            rooms,
            users: { [uid]: { uid, createdRooms: { done: true }, joinedRooms: { done: true } } }
        });
        let err = null;
        try {
            await RoomSync.enterRoom('done');
        } catch (e) {
            err = e;
        }
        ok(
            'entering an ended room is rejected as ended',
            !!(err && /ended/i.test(err.message) && !/expired/i.test(err.message)),
            err && err.message
        );
        ok('entering an ended room does not purge it', after.done != null && after.done.status === 'ended');
        ok(
            'entering an ended room drops it from the user maps',
            !(users[uid].joinedRooms && users[uid].joinedRooms.done)
                && !(users[uid].createdRooms && users[uid].createdRooms.done),
            JSON.stringify(users[uid])
        );
    }

    {
        const uid = 'bob';
        const rooms = {
            r1: Object.assign(liveRoom('host', '0421'), {
                participants: {
                    host: { displayName: 'Host', role: 'host', lastSeen: Date.now(), joinedAt: 1 },
                    bob: { displayName: 'Bob', role: 'viewer', lastSeen: Date.now(), joinedAt: 2 }
                }
            })
        };
        const { RoomSync, rooms: after, fireDocSnapshot } = loadRoom({
            uid,
            rooms,
            roomCodes: { '0421': { roomId: 'r1' } },
            users: { bob: { uid: 'bob', createdRooms: {}, joinedRooms: { r1: true } } }
        });
        const live = await RoomSync.enterRoom('r1');
        ok('guest enters a live room before it ends', !!(live && live.roomId === 'r1'), JSON.stringify(live));
        after.r1.status = 'ended';
        after.r1.expiresAt = Date.now();
        const fired = fireDocSnapshot('rooms', 'r1');
        ok('live listener received the ended snapshot', fired);
        const snap = RoomSync.getRoomSnapshot();
        ok(
            'live listener keeps the ended room attached',
            !!(snap && snap.roomId === 'r1' && snap.status === 'ended'),
            JSON.stringify(snap)
        );
        ok(
            'live listener does not purge an ended room',
            after.r1 != null && after.r1.status === 'ended',
            JSON.stringify(after.r1)
        );
    }

    {
        const { RoomSync, storage } = loadRoom({ ensureAuthFails: true });
        storage.setItem('pst_room_id', 'held');
        const restored = await RoomSync.tryRestoreRoom();
        ok('restore error does not attach', restored == null, JSON.stringify(restored));
        ok('restore error keeps local room id', storage.getItem('pst_room_id') === 'held');
    }

    {
        const rooms = {
            r1: Object.assign(liveRoom('host', '0421'), {
                participants: {
                    host: { displayName: 'Host', role: 'host', lastSeen: Date.now(), joinedAt: 1 },
                    bob: { displayName: 'Bob', role: 'viewer', lastSeen: Date.now(), joinedAt: 2 }
                }
            })
        };
        const { RoomSync, users, storage } = loadRoom({
            uid: 'bob',
            rooms,
            roomCodes: { '0421': { roomId: 'r1' } },
            users: { bob: { uid: 'bob', createdRooms: {}, joinedRooms: {} } }
        });
        storage.setItem('pst_room_id', 'r1');
        const restored = await RoomSync.tryRestoreRoom();
        ok(
            'restore attaches a live guest',
            !!(restored && restored.roomId === 'r1' && restored.status === 'active'),
            JSON.stringify(restored)
        );
        ok(
            'restore backfills joinedRooms for a guest',
            !!(users.bob.joinedRooms && users.bob.joinedRooms.r1 === true),
            JSON.stringify(users.bob)
        );
        await RoomSync.detachRoom();
        ok('restore then detach clears local room id', storage.getItem('pst_room_id') == null);
        const listed = await RoomSync.listMyRooms();
        ok(
            'guest can list the restored room after detach',
            listed.some((r) => r.roomId === 'r1'),
            JSON.stringify(listed)
        );
    }

    {
        const { RoomSync, rooms, roomCodes } = loadRoom();
        const snap = await RoomSync.createRoom('River', { players: [], stackAmount: 200 });
        const code = snap.code;
        const roomId = snap.roomId;
        await RoomSync.leaveRoom();
        ok(
            'leave as last person keeps the room active',
            !!(rooms[roomId] && rooms[roomId].status === 'active'),
            JSON.stringify(rooms[roomId])
        );
        ok(
            'leave as last person keeps the join code',
            !!(roomCodes[code] && roomCodes[code].roomId === roomId),
            JSON.stringify(roomCodes)
        );
        ok('leave as last person does not mark abandoned', rooms[roomId].status !== 'abandoned');
        const again = await RoomSync.joinRoom(code, 'River');
        ok(
            'host can rejoin with the same code after leaving',
            !!(again && again.roomId === roomId && again.role === 'host' && again.code === code),
            JSON.stringify(again)
        );
    }

    {
        const uid = 'alice';
        const rooms = {
            hosted: Object.assign(liveRoom(uid, '1111'), {
                game: { sessionName: 'Hosted night' },
                updatedAt: 30
            }),
            joined: Object.assign(liveRoom('host', '2222'), {
                participants: {
                    host: { displayName: 'Host', role: 'host', lastSeen: Date.now(), joinedAt: 1 },
                    [uid]: { displayName: 'Alice', role: 'viewer', lastSeen: Date.now(), joinedAt: 2 }
                },
                game: { sessionName: 'Joined night' },
                updatedAt: 40
            }),
            ended: endedRoom(uid, '3333'),
            expired: Object.assign(liveRoom(uid, '4444'), { expiresAt: Date.now() - 1000 }),
            abandoned: Object.assign(liveRoom(uid, '5555'), { status: 'abandoned' }),
            left: Object.assign(liveRoom('host', '6666'), {
                participants: {
                    host: { displayName: 'Host', role: 'host', lastSeen: Date.now(), joinedAt: 1 }
                }
            })
        };
        const { RoomSync, users } = loadRoom({
            uid,
            rooms,
            users: {
                [uid]: {
                    uid,
                    createdRooms: { hosted: true, ended: true, expired: true, abandoned: true },
                    joinedRooms: { hosted: true, joined: true, ended: true, expired: true, abandoned: true, left: true, missing: true }
                }
            }
        });
        const listed = await RoomSync.listMyRooms();
        const ids = listed.map((r) => r.roomId).sort();
        ok(
            'listMyRooms keeps live hosted and joined rooms',
            ids.join(',') === 'hosted,joined',
            JSON.stringify(listed)
        );
        ok(
            'listMyRooms uses session name and role',
            listed.some((r) => r.roomId === 'hosted' && r.sessionName === 'Hosted night' && r.role === 'host' && r.code === '1111')
                && listed.some((r) => r.roomId === 'joined' && r.sessionName === 'Joined night' && r.role === 'viewer'),
            JSON.stringify(listed)
        );
        ok(
            'listMyRooms drops ended, expired, abandoned, left, and missing ids',
            !users[uid].joinedRooms.ended
                && !users[uid].joinedRooms.expired
                && !users[uid].joinedRooms.abandoned
                && !users[uid].joinedRooms.left
                && !users[uid].joinedRooms.missing
                && !users[uid].createdRooms.ended
                && !users[uid].createdRooms.expired
                && !users[uid].createdRooms.abandoned,
            JSON.stringify(users[uid])
        );
        ok(
            'listMyRooms sorts by recency',
            listed[0].roomId === 'joined' && listed[1].roomId === 'hosted',
            JSON.stringify(listed.map((r) => r.roomId))
        );
        ok(
            'listMyRooms does not purge an ended room',
            rooms.ended != null && rooms.ended.status === 'ended',
            JSON.stringify(rooms.ended)
        );
    }

    {
        const { RoomSync, rooms, uid, storage } = loadRoom();
        const snap = await RoomSync.createRoom('River', { players: [], stackAmount: 200 });
        await RoomSync.detachRoom();
        ok('detach clears local room id', storage.getItem('pst_room_id') == null);
        ok('detach is not in a room', RoomSync.isInRoom() === false);
        ok(
            'detach keeps the participant',
            !!(rooms[snap.roomId] && rooms[snap.roomId].participants && rooms[snap.roomId].participants[uid]),
            JSON.stringify(rooms[snap.roomId] && rooms[snap.roomId].participants)
        );
        const listed = await RoomSync.listMyRooms();
        ok(
            'detached room still appears on the home list',
            listed.some((r) => r.roomId === snap.roomId),
            JSON.stringify(listed)
        );
        const entered = await RoomSync.enterRoom(snap.roomId);
        ok(
            'enterRoom reattaches without a code',
            !!(entered && entered.roomId === snap.roomId && RoomSync.isInRoom()),
            JSON.stringify(entered)
        );
        ok('enterRoom restores local room id', storage.getItem('pst_room_id') === snap.roomId);
    }

    {
        const rooms = {
            r1: Object.assign(liveRoom('host', '0421'), {
                participants: {
                    host: { displayName: 'Host', role: 'host', lastSeen: Date.now(), joinedAt: 1 },
                    bob: { displayName: 'Bob', role: 'viewer', lastSeen: Date.now(), joinedAt: 2 }
                }
            })
        };
        const { RoomSync, users } = loadRoom({
            uid: 'bob',
            rooms,
            roomCodes: { '0421': { roomId: 'r1' } },
            users: { bob: { uid: 'bob', createdRooms: {}, joinedRooms: { r1: true } } }
        });
        await RoomSync.enterRoom('r1');
        await RoomSync.leaveRoom();
        ok(
            'guest leave removes the participant',
            !(rooms.r1.participants && rooms.r1.participants.bob),
            JSON.stringify(rooms.r1.participants)
        );
        ok(
            'guest leave drops joinedRooms',
            !(users.bob.joinedRooms && users.bob.joinedRooms.r1),
            JSON.stringify(users.bob)
        );
        let err = null;
        try {
            await RoomSync.enterRoom('r1');
        } catch (e) {
            err = e;
        }
        ok(
            'enterRoom after leave requires joining with the code',
            !!(err && /not in this room/i.test(String(err.message || ''))),
            String((err && err.message) || err)
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
