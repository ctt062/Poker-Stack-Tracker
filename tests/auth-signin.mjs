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
    const users = options.users || {};
    const storage = memStorage(options.localStorage || {});
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
                            currentUser: user,
                            useDeviceLanguage() {},
                            async getRedirectResult() { return { user: null }; },
                            onAuthStateChanged(cb) {
                                cb(user);
                                return () => {};
                            },
                            async signOut() {}
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
                                        doc(id) {
                                            return {
                                                async get() {
                                                    const data = name === 'users' ? users[id] : null;
                                                    return { exists: !!data, data: () => data };
                                                }
                                            };
                                        }
                                    };
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
    return { AppAuth: sandbox.AppAuth, storage };
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
