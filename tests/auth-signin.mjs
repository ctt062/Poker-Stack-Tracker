#!/usr/bin/env node
/**
 * Sign-in must wait for the Firebase Auth SDK. Local leftover names are not
 * treated as a claimed unique display name.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');

function memStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: (k) => { map.delete(k); },
        key: (i) => Array.from(map.keys())[i] || null,
        get length() { return map.size; }
    };
}

function loadAuth(options = {}) {
    const user = options.user || null;
    let currentUser = user;
    const users = { ...(options.users || {}) };
    const displayNames = { ...(options.displayNames || {}) };
    const storage = memStorage(options.localStorage || {});
    const authListeners = [];

    function notifyAuth(nextUser) {
        authListeners.slice().forEach((cb) => cb(nextUser));
    }

    function storeGet(col, id) {
        const data = col === 'users' ? users[id] : displayNames[id];
        return { exists: !!data, data: () => data };
    }

    function makeRef(col, id) {
        return {
            col,
            id,
            async get() {
                if (col === 'users' && options.refreshUserError) {
                    throw options.refreshUserError;
                }
                if (col === 'users' && options.refreshUserEmpty) {
                    return { exists: false, data: () => undefined };
                }
                if (col === 'users' && typeof options.refreshUserGet === 'function') {
                    return options.refreshUserGet({ id, users });
                }
                return storeGet(col, id);
            }
        };
    }

    const sandbox = {
        console,
        localStorage: storage,
        FIREBASE_CONFIG: { apiKey: 'test', projectId: 'p', appId: 'a' },
        firebase: undefined,
        document: {
            createElement() {
                const el = { src: '', async: false, onload: null, onerror: null };
                queueMicrotask(() => {
                    if (options.sdkLoads === false) {
                        if (typeof el.onerror === 'function') el.onerror();
                        return;
                    }
                    const authFn = function auth() {
                        return {
                            get currentUser() { return currentUser; },
                            useDeviceLanguage() {},
                            async getRedirectResult() { return { user: null }; },
                            onAuthStateChanged(cb) {
                                authListeners.push(cb);
                                cb(currentUser);
                                return () => {
                                    const i = authListeners.indexOf(cb);
                                    if (i >= 0) authListeners.splice(i, 1);
                                };
                            },
                            async signOut() {
                                currentUser = null;
                                notifyAuth(null);
                            },
                            async signInWithEmailAndPassword(email, password) {
                                if (!user) {
                                    const err = new Error('No account');
                                    err.code = 'auth/user-not-found';
                                    throw err;
                                }
                                currentUser = user;
                                notifyAuth(user);
                                return { user };
                            },
                            async createUserWithEmailAndPassword(email, password) {
                                const created = {
                                    uid: options.newUid || 'new-user',
                                    email,
                                    isAnonymous: false,
                                    displayName: '',
                                    providerData: [{ providerId: 'password' }],
                                    async updateProfile(profile) {
                                        if (profile && profile.displayName != null) {
                                            created.displayName = profile.displayName;
                                        }
                                    }
                                };
                                currentUser = created;
                                notifyAuth(created);
                                return { user: created };
                            }
                        };
                    };
                    authFn.GoogleAuthProvider = function GoogleAuthProvider() {
                        this.addScope = () => {};
                        this.setCustomParameters = () => {};
                    };
                    authFn.OAuthProvider = function OAuthProvider() {
                        this.addScope = () => {};
                    };
                    sandbox.firebase = {
                        apps: [{}],
                        initializeApp() {},
                        auth: authFn,
                        firestore() {
                            return {
                                collection(name) {
                                    return {
                                        doc(id) { return makeRef(name, id); }
                                    };
                                },
                                async runTransaction(fn) {
                                    const tx = {
                                        async get(ref) { return storeGet(ref.col, ref.id); },
                                        set(ref, data, opts) {
                                            const store = ref.col === 'users' ? users : displayNames;
                                            if (opts && opts.merge && store[ref.id]) {
                                                store[ref.id] = Object.assign({}, store[ref.id], data);
                                            } else {
                                                store[ref.id] = data;
                                            }
                                        },
                                        delete(ref) {
                                            const store = ref.col === 'users' ? users : displayNames;
                                            delete store[ref.id];
                                        }
                                    };
                                    return fn(tx);
                                }
                            };
                        }
                    };
                    if (typeof el.onload === 'function') el.onload();
                });
                return el;
            },
            head: { appendChild() {} }
        }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { AppAuth: sandbox.AppAuth, storage, users, displayNames };
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
        const { AppAuth } = loadAuth({ sdkLoads: false });
        let err = null;
        try {
            await AppAuth.signInGoogle();
        } catch (e) {
            err = e;
        }
        const message = String((err && err.message) || err || '');
        ok(
            'Google sign-in before SDK is a friendly error',
            /could not reach firebase/i.test(message),
            message
        );
        ok(
            'Google sign-in before SDK does not read undefined auth',
            !/reading 'auth'/i.test(message) && !/undefined/i.test(message),
            message
        );
    }

    {
        const { AppAuth } = loadAuth({ sdkLoads: false });
        let err = null;
        try {
            await AppAuth.signInApple();
        } catch (e) {
            err = e;
        }
        const message = String((err && err.message) || err || '');
        ok(
            'Apple sign-in before SDK is a friendly error',
            /could not reach firebase/i.test(message),
            message
        );
        ok(
            'Apple sign-in before SDK does not read undefined auth',
            !/reading 'auth'/i.test(message) && !/undefined/i.test(message),
            message
        );
    }

    {
        const user = { uid: 'alice', isAnonymous: false, displayName: 'Alice From Google' };
        const { AppAuth, storage } = loadAuth({
            user,
            users: {},
            localStorage: { pst_display_name_alice: 'StaleName', pst_display_name: 'Legacy' }
        });
        const snap = await AppAuth.init();
        ok(
            'stale local display name is not claimed after registry miss',
            snap.signedIn === true && snap.displayName === '',
            JSON.stringify(snap)
        );
        ok(
            'legacy local display names are purged',
            storage.getItem('pst_display_name_alice') == null
                && storage.getItem('pst_display_name') == null
                && storage.getItem('pst_display_name_epoch') === '2',
            JSON.stringify({
                uid: storage.getItem('pst_display_name_alice'),
                legacy: storage.getItem('pst_display_name'),
                epoch: storage.getItem('pst_display_name_epoch')
            })
        );
        ok(
            'Google profile name is only a suggestion',
            AppAuth.suggestedDisplayName() === 'Alice From Google',
            AppAuth.suggestedDisplayName()
        );
    }

    {
        const user = { uid: 'bob', isAnonymous: false, displayName: 'Ignored' };
        const { AppAuth } = loadAuth({
            user,
            users: { bob: { uid: 'bob', displayName: 'River', nameKey: 'river' } }
        });
        const snap = await AppAuth.init();
        ok(
            'claimed Firestore name is the display name',
            snap.displayName === 'River',
            JSON.stringify(snap)
        );
    }

    {
        const { AppAuth } = loadAuth({ sdkLoads: false, user: null });
        const saved = await AppAuth.setDisplayName('River');
        ok('local name save returns the name', saved === 'River', saved);
        ok(
            'local name save is readable without a Firebase user',
            AppAuth.getDisplayName() === 'River',
            AppAuth.getDisplayName()
        );
    }

    {
        const user = {
            uid: 'bob',
            isAnonymous: false,
            email: 'bob@example.com',
            displayName: 'Ignored',
            providerData: [{ providerId: 'password' }]
        };
        const { AppAuth } = loadAuth({
            user,
            users: { bob: { uid: 'bob', displayName: 'River', nameKey: 'river' } }
        });
        await AppAuth.init();
        const snap = await AppAuth.signInEmail('bob@example.com', 'secret');
        ok(
            'sign-in snapshot waits for the claimed Firestore name',
            snap.signedIn === true && snap.displayName === 'River',
            JSON.stringify(snap)
        );
    }

    {
        let created = false;
        const { AppAuth } = loadAuth({ user: null });
        await AppAuth.init();
        let err = null;
        try {
            await AppAuth.createEmailAccount('new@example.com', 'secret1', '  ');
            created = true;
        } catch (e) {
            err = e;
        }
        ok(
            'create account without a display name is rejected',
            !created && /display name/i.test(String((err && err.message) || '')),
            String((err && err.message) || err)
        );
    }

    {
        const { AppAuth, users, displayNames } = loadAuth({ user: null, newUid: 'new-user' });
        await AppAuth.init();
        const snap = await AppAuth.createEmailAccount('new@example.com', 'secret1', 'River');
        ok(
            'create account claims the display name in the same step',
            snap.signedIn === true && snap.displayName === 'River' && snap.email === 'new@example.com',
            JSON.stringify(snap)
        );
        ok(
            'create account writes the unique name registry',
            displayNames.river && displayNames.river.uid === 'new-user'
                && users['new-user'] && users['new-user'].displayName === 'River',
            JSON.stringify({ users, displayNames })
        );
    }

    {
        const { AppAuth } = loadAuth({
            user: null,
            newUid: 'taken-user',
            displayNames: { river: { uid: 'someone-else', displayName: 'River' } }
        });
        await AppAuth.init();
        let err = null;
        let snap = null;
        try {
            snap = await AppAuth.createEmailAccount('new@example.com', 'secret1', 'River');
        } catch (e) {
            err = e;
            snap = AppAuth.snapshot();
        }
        ok(
            'create account with a taken name still signs the user in',
            snap && snap.signedIn === true && snap.displayName === '',
            JSON.stringify(snap)
        );
        ok(
            'create account with a taken name reports the clash',
            err && /already taken/i.test(String(err.message || '')),
            String((err && err.message) || err)
        );
    }

    {
        const { AppAuth, users, displayNames } = loadAuth({
            user: null,
            newUid: 'race-user',
            refreshUserEmpty: true
        });
        await AppAuth.init();
        const signedInNames = [];
        AppAuth.on('user', (snap) => {
            if (snap && snap.signedIn) signedInNames.push(snap.displayName);
        });
        const snap = await AppAuth.createEmailAccount('race@example.com', 'secret1', 'River');
        ok(
            'create keeps claimed name when auth listener refresh is empty',
            snap.signedIn === true && snap.displayName === 'River' && AppAuth.getDisplayName() === 'River',
            JSON.stringify({ snap, signedInNames, users, displayNames })
        );
        ok(
            'empty auth-listener refresh does not emit a blank name over the claim',
            signedInNames.length > 0 && signedInNames.every((name) => name === 'River'),
            JSON.stringify(signedInNames)
        );
        ok(
            'empty refresh after create does not drop the unique name registry',
            displayNames.river && displayNames.river.uid === 'race-user'
                && users['race-user'] && users['race-user'].displayName === 'River',
            JSON.stringify({ users, displayNames })
        );
    }

    {
        let finishRefresh;
        const held = new Promise((resolve) => { finishRefresh = resolve; });
        let refreshStarts = 0;
        const { AppAuth } = loadAuth({
            user: null,
            newUid: 'late-user',
            refreshUserGet: async () => {
                refreshStarts += 1;
                await held;
                return { exists: false, data: () => undefined };
            }
        });
        await AppAuth.init();
        const pending = AppAuth.createEmailAccount('late@example.com', 'secret1', 'River');
        const started = await new Promise((resolve) => {
            const tick = () => {
                if (refreshStarts > 0) resolve(true);
                else setTimeout(tick, 0);
            };
            tick();
        });
        finishRefresh();
        const snap = await pending;
        ok('create waits for the in-flight name refresh', started === true, String(refreshStarts));
        ok(
            'late empty refresh cannot clobber a newer claimed name',
            snap.signedIn === true && snap.displayName === 'River' && AppAuth.getDisplayName() === 'River',
            JSON.stringify(snap)
        );
    }

    {
        const { AppAuth } = loadAuth({
            user: null,
            newUid: 'offline-user',
            refreshUserError: new Error('offline')
        });
        await AppAuth.init();
        const signedInNames = [];
        AppAuth.on('user', (snap) => {
            if (snap && snap.signedIn) signedInNames.push(snap.displayName);
        });
        const snap = await AppAuth.createEmailAccount('offline@example.com', 'secret1', 'River');
        ok(
            'failed name refresh after claim does not wipe the claimed name',
            snap.signedIn === true && snap.displayName === 'River' && AppAuth.getDisplayName() === 'River',
            JSON.stringify({ snap, signedInNames })
        );
        ok(
            'failed name refresh does not emit a blank name over the claim',
            signedInNames.length > 0 && signedInNames.every((name) => name === 'River'),
            JSON.stringify(signedInNames)
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
