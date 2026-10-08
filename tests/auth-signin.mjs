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
    let currentUser = options.signedOut ? null : user;
    const users = { ...(options.users || {}) };
    const displayNames = { ...(options.displayNames || {}) };
    const storage = memStorage(options.localStorage || {});
    const authListeners = [];
    let lastGoogleParams = null;
    let lastGoogleMethod = null;
    let linkedCredential = null;

    function attachLink(target) {
        if (!target) return target;
        if (typeof target.linkWithCredential !== 'function') {
            target.linkWithCredential = async (cred) => {
                linkedCredential = cred;
                const data = Array.isArray(target.providerData) ? target.providerData.slice() : [];
                if (!data.some((p) => p && p.providerId === 'google.com')) {
                    data.push({ providerId: 'google.com' });
                }
                target.providerData = data;
                target.emailVerified = true;
                currentUser = target;
                notifyAuth(target);
                return { user: target };
            };
        }
        if (typeof target.linkWithPopup !== 'function') {
            target.linkWithPopup = async () => {
                lastGoogleMethod = 'popup';
                const data = Array.isArray(target.providerData) ? target.providerData.slice() : [];
                if (!data.some((p) => p && p.providerId === 'google.com')) {
                    data.push({ providerId: 'google.com' });
                }
                target.providerData = data;
                target.emailVerified = true;
                currentUser = target;
                notifyAuth(target);
                return { user: target };
            };
        }
        return target;
    }
    if (user) attachLink(user);

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
        FIREBASE_CONFIG: {
            apiKey: 'test',
            projectId: 'p',
            appId: 'a',
            authDomain: 'poker-stack-tracker.firebaseapp.com'
        },
        location: options.location || { hostname: 'ctt062.github.io' },
        navigator: options.navigator || {
            userAgent: 'node',
            platform: 'node',
            standalone: false,
            maxTouchPoints: 0
        },
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
                            async getRedirectResult() {
                                if (options.redirectError) throw options.redirectError;
                                if (options.redirectUser) {
                                    attachLink(options.redirectUser);
                                    currentUser = options.redirectUser;
                                    return { user: options.redirectUser };
                                }
                                return { user: null };
                            },
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
                                if (options.emailSignInError) throw options.emailSignInError;
                                if (!user) {
                                    const err = new Error('No account');
                                    err.code = 'auth/user-not-found';
                                    throw err;
                                }
                                currentUser = user;
                                notifyAuth(user);
                                return { user };
                            },
                            async signInWithPopup() {
                                lastGoogleMethod = 'popup';
                                if (options.googleSignInError) throw options.googleSignInError;
                                const gUser = options.googleUser || user;
                                if (!gUser) {
                                    const err = new Error('No Google user');
                                    err.code = 'auth/internal-error';
                                    throw err;
                                }
                                attachLink(gUser);
                                currentUser = gUser;
                                notifyAuth(gUser);
                                return { user: gUser };
                            },
                            async signInWithRedirect() {
                                lastGoogleMethod = 'redirect';
                                if (options.googleRedirectError) throw options.googleRedirectError;
                            },
                            async fetchSignInMethodsForEmail(email) {
                                if (typeof options.fetchSignInMethods === 'function') {
                                    return options.fetchSignInMethods(email);
                                }
                                return options.signInMethods || [];
                            },
                            async createUserWithEmailAndPassword(email, password) {
                                const created = {
                                    uid: options.newUid || 'new-user',
                                    email,
                                    emailVerified: false,
                                    isAnonymous: false,
                                    displayName: '',
                                    verificationSent: 0,
                                    providerData: [{ providerId: 'password' }],
                                    async updateProfile(profile) {
                                        if (profile && profile.displayName != null) {
                                            created.displayName = profile.displayName;
                                        }
                                    },
                                    async sendEmailVerification() {
                                        created.verificationSent += 1;
                                        if (options.sendVerificationError) {
                                            throw options.sendVerificationError;
                                        }
                                    },
                                    async reload() {
                                        if (options.verifyOnReload) created.emailVerified = true;
                                    }
                                };
                                attachLink(created);
                                currentUser = created;
                                notifyAuth(created);
                                return { user: created };
                            }
                        };
                    };
                    authFn.GoogleAuthProvider = function GoogleAuthProvider() {
                        this.addScope = () => {};
                        this.setCustomParameters = (params) => {
                            lastGoogleParams = params || {};
                            this.params = lastGoogleParams;
                        };
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
    return {
        AppAuth: sandbox.AppAuth,
        storage,
        users,
        displayNames,
        getUser: () => currentUser,
        googleParams: () => lastGoogleParams,
        lastGoogleMethod: () => lastGoogleMethod,
        linkedCredential: () => linkedCredential
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
            'legacy unscoped display names are purged',
            storage.getItem('pst_display_name') == null
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
            emailVerified: true,
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
        const { AppAuth, users, displayNames, getUser } = loadAuth({ user: null, newUid: 'new-user' });
        await AppAuth.init();
        const snap = await AppAuth.createEmailAccount('new@example.com', 'secret1', 'River');
        ok(
            'create account signs in unverified and does not claim the name yet',
            snap.signedIn === true
                && snap.emailVerified === false
                && snap.displayName === ''
                && snap.email === 'new@example.com',
            JSON.stringify(snap)
        );
        ok(
            'create account sends a verification email',
            getUser() && getUser().verificationSent === 1,
            JSON.stringify(getUser() && { sent: getUser().verificationSent, emailVerified: getUser().emailVerified })
        );
        ok(
            'create keeps the typed name as a suggestion until verify',
            AppAuth.suggestedDisplayName() === 'River',
            AppAuth.suggestedDisplayName()
        );
        ok(
            'create does not write the unique name registry before verify',
            !displayNames.river && !users['new-user'],
            JSON.stringify({ users, displayNames })
        );
    }

    {
        const { AppAuth, users, displayNames } = loadAuth({
            user: null,
            newUid: 'verify-user',
            verifyOnReload: true
        });
        await AppAuth.init();
        await AppAuth.createEmailAccount('new@example.com', 'secret1', 'River');
        const before = AppAuth.snapshot();
        ok('create stays unverified until reload', before.emailVerified === false, JSON.stringify(before));
        const snap = await AppAuth.refreshEmailVerification();
        ok(
            'verify claims the pending display name',
            snap.emailVerified === true && snap.displayName === 'River',
            JSON.stringify(snap)
        );
        ok(
            'verify writes the unique name registry',
            displayNames.river && displayNames.river.uid === 'verify-user'
                && users['verify-user'] && users['verify-user'].displayName === 'River',
            JSON.stringify({ users, displayNames })
        );
    }

    {
        const { AppAuth } = loadAuth({
            user: null,
            newUid: 'taken-user',
            verifyOnReload: true,
            displayNames: { river: { uid: 'someone-else', displayName: 'River' } }
        });
        await AppAuth.init();
        await AppAuth.createEmailAccount('new@example.com', 'secret1', 'River');
        const snap = await AppAuth.refreshEmailVerification();
        ok(
            'verified account with a taken name stays signed in without a claim',
            snap.signedIn === true && snap.emailVerified === true && snap.displayName === '',
            JSON.stringify(snap)
        );
    }

    {
        const { AppAuth, users, displayNames } = loadAuth({
            user: null,
            newUid: 'race-user',
            verifyOnReload: true,
            refreshUserEmpty: true
        });
        await AppAuth.init();
        await AppAuth.createEmailAccount('race@example.com', 'secret1', 'River');
        const signedInNames = [];
        AppAuth.on('user', (snap) => {
            if (snap && snap.signedIn) signedInNames.push(snap.displayName);
        });
        const snap = await AppAuth.refreshEmailVerification();
        ok(
            'verify keeps claimed name when auth listener refresh is empty',
            snap.signedIn === true && snap.displayName === 'River' && AppAuth.getDisplayName() === 'River',
            JSON.stringify({ snap, signedInNames, users, displayNames })
        );
        ok(
            'empty auth-listener refresh does not emit a blank name over the claim',
            signedInNames.length > 0 && signedInNames.every((name) => name === 'River'),
            JSON.stringify(signedInNames)
        );
        ok(
            'empty refresh after verify does not drop the unique name registry',
            displayNames.river && displayNames.river.uid === 'race-user'
                && users['race-user'] && users['race-user'].displayName === 'River',
            JSON.stringify({ users, displayNames })
        );
    }

    {
        const { AppAuth } = loadAuth({
            user: null,
            newUid: 'offline-user',
            verifyOnReload: true,
            refreshUserError: new Error('offline')
        });
        await AppAuth.init();
        await AppAuth.createEmailAccount('offline@example.com', 'secret1', 'River');
        const snap = await AppAuth.refreshEmailVerification();
        ok(
            'verify claims the pending name even if the registry refresh fails',
            snap.signedIn === true && snap.emailVerified === true && snap.displayName === 'River',
            JSON.stringify(snap)
        );
    }

    {
        const user = {
            uid: 'unverified',
            isAnonymous: false,
            email: 'u@example.com',
            emailVerified: false,
            providerData: [{ providerId: 'password' }]
        };
        const { AppAuth } = loadAuth({ user });
        await AppAuth.init();
        let err = null;
        try {
            await AppAuth.ensureAuth();
        } catch (e) {
            err = e;
        }
        ok(
            'ensureAuth rejects unverified email accounts',
            !!(err && /verify your email/i.test(String(err.message || ''))),
            String((err && err.message) || err)
        );
    }

    {
        const user = {
            uid: 'google-user',
            isAnonymous: false,
            email: 'g@example.com',
            emailVerified: false,
            providerData: [{ providerId: 'google.com' }]
        };
        const { AppAuth } = loadAuth({ user });
        const snap = await AppAuth.ensureAuth();
        ok(
            'ensureAuth allows Google without a password verification step',
            snap.signedIn === true && snap.provider === 'google.com',
            JSON.stringify(snap)
        );
    }

    {
        const user = {
            uid: 'verified',
            isAnonymous: false,
            email: 'v@example.com',
            emailVerified: true,
            providerData: [{ providerId: 'password' }]
        };
        const { AppAuth } = loadAuth({
            user,
            users: { verified: { uid: 'verified', displayName: 'River', nameKey: 'river' } }
        });
        const snap = await AppAuth.ensureAuth();
        ok(
            'ensureAuth allows verified email accounts',
            snap.signedIn === true && snap.emailVerified === true,
            JSON.stringify(snap)
        );
    }

    {
        const googleUser = {
            uid: 'g1',
            email: 'river@gmail.com',
            emailVerified: true,
            isAnonymous: false,
            displayName: 'River',
            providerData: [{ providerId: 'google.com' }]
        };
        const { AppAuth, googleParams, storage } = loadAuth({
            googleUser,
            users: { g1: { uid: 'g1', displayName: 'River', nameKey: 'river' } }
        });
        await AppAuth.init();
        const snap = await AppAuth.signInGoogle();
        ok('Google sign-in does not force the account picker', googleParams() == null || googleParams().prompt !== 'select_account', JSON.stringify(googleParams()));
        ok('Google sign-in remembers the email for next time', storage.getItem('pst_google_login_hint') === 'river@gmail.com', storage.getItem('pst_google_login_hint'));
        ok('Google snapshot skips extra email verification', snap.hasGoogle === true && snap.provider === 'google.com', JSON.stringify(snap));
    }

    {
        const googleUser = {
            uid: 'g1',
            email: 'river@gmail.com',
            emailVerified: true,
            isAnonymous: false,
            providerData: [{ providerId: 'google.com' }]
        };
        const { AppAuth, googleParams } = loadAuth({ googleUser });
        await AppAuth.init();
        await AppAuth.signInGoogle({ loginHint: 'river@gmail.com' });
        ok(
            'Google sign-in sends login_hint so the email is not typed again',
            googleParams() && googleParams().login_hint === 'river@gmail.com' && googleParams().prompt !== 'select_account',
            JSON.stringify(googleParams())
        );
        await AppAuth.signOut({ pickNextGoogleAccount: true });
        await AppAuth.signInGoogle();
        ok(
            'Use a different account asks Google to pick',
            googleParams() && googleParams().prompt === 'select_account',
            JSON.stringify(googleParams())
        );
    }

    {
        const passwordUser = {
            uid: 'p1',
            email: 'river@gmail.com',
            emailVerified: true,
            isAnonymous: false,
            displayName: 'River',
            providerData: [{ providerId: 'password' }]
        };
        const pendingCred = { providerId: 'google.com', id: 'pending-google' };
        const googleErr = new Error('exists');
        googleErr.code = 'auth/account-exists-with-different-credential';
        googleErr.email = 'river@gmail.com';
        googleErr.credential = pendingCred;
        const { AppAuth, linkedCredential } = loadAuth({
            user: passwordUser,
            googleSignInError: googleErr,
            signInMethods: ['password'],
            users: { p1: { uid: 'p1', displayName: 'River', nameKey: 'river' } }
        });
        await AppAuth.init();
        let err = null;
        try {
            await AppAuth.signInGoogle();
        } catch (e) {
            err = e;
        }
        ok(
            'Google on a password account asks to sign in with password to connect',
            !!(err && /password/i.test(err.message) && err.email === 'river@gmail.com'),
            String((err && err.message) || err)
        );
        const snap = await AppAuth.signInEmail('river@gmail.com', 'secret');
        ok('password sign-in links the pending Google credential', linkedCredential() === pendingCred, JSON.stringify(linkedCredential()));
        ok('linked account is treated as Google', snap.hasGoogle === true && snap.provider === 'google.com', JSON.stringify(snap));
    }

    {
        const passwordUser = {
            uid: 'p1',
            email: 'river@gmail.com',
            emailVerified: false,
            isAnonymous: false,
            providerData: [{ providerId: 'password' }, { providerId: 'google.com' }]
        };
        const { AppAuth } = loadAuth({ user: passwordUser });
        const snap = await AppAuth.init();
        ok(
            'password-first user with Google linked skips the verify gate',
            snap.provider === 'google.com' && snap.hasGoogle === true,
            JSON.stringify(snap)
        );
    }

    {
        const { AppAuth } = loadAuth({
            emailSignInError: Object.assign(new Error('bad'), { code: 'auth/invalid-credential' }),
            signInMethods: ['google.com']
        });
        await AppAuth.init();
        let err = null;
        try {
            await AppAuth.signInEmail('river@gmail.com', 'nope');
        } catch (e) {
            err = e;
        }
        ok(
            'password sign-in on a Google-only email points at Google',
            !!(err && /continue with google/i.test(err.message)),
            String((err && err.message) || err)
        );
    }

    {
        const { AppAuth } = loadAuth({
            emailSignInError: Object.assign(new Error('bad'), { code: 'auth/invalid-credential' }),
            signInMethods: []
        });
        await AppAuth.init();
        let err = null;
        try {
            await AppAuth.signInEmail('chongtt062@gmail.com', 'gmail-password');
        } catch (e) {
            err = e;
        }
        ok(
            'hidden providers still tell Gmail to use Google, not the Google password',
            !!(err && /continue with google/i.test(err.message) && /google password/i.test(err.message)),
            String((err && err.message) || err)
        );
    }

    {
        const googleUser = {
            uid: 'g-ios',
            email: 'chongtt062@gmail.com',
            emailVerified: true,
            isAnonymous: false,
            displayName: 'Chong',
            providerData: [{ providerId: 'google.com' }]
        };
        const { AppAuth, lastGoogleMethod } = loadAuth({
            googleUser,
            navigator: {
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
                platform: 'iPhone',
                standalone: true,
                maxTouchPoints: 5
            },
            location: { hostname: 'ctt062.github.io' },
            users: { 'g-ios': { uid: 'g-ios', displayName: 'Chong', nameKey: 'chong' } }
        });
        await AppAuth.init();
        const snap = await AppAuth.signInGoogle({ loginHint: 'chongtt062@gmail.com' });
        ok(
            'iPhone Google uses popup, not a cross-site redirect',
            lastGoogleMethod() === 'popup',
            lastGoogleMethod()
        );
        ok(
            'iPhone Google signs in without an app password',
            snap.signedIn === true && snap.hasGoogle === true && snap.email === 'chongtt062@gmail.com',
            JSON.stringify(snap)
        );
    }

    {
        const popupErr = new Error('blocked');
        popupErr.code = 'auth/popup-blocked';
        const { AppAuth, lastGoogleMethod } = loadAuth({
            googleSignInError: popupErr,
            navigator: {
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
                platform: 'iPhone',
                standalone: true,
                maxTouchPoints: 5
            },
            location: { hostname: 'ctt062.github.io' }
        });
        await AppAuth.init();
        let err = null;
        try {
            await AppAuth.signInGoogle();
        } catch (e) {
            err = e;
        }
        ok(
            'blocked popup on GitHub Pages does not fall back to redirect',
            lastGoogleMethod() === 'popup',
            lastGoogleMethod()
        );
        ok(
            'blocked popup asks to open a browser window',
            !!(err && /browser window|safari|popup/i.test(err.message)),
            String((err && err.message) || err)
        );
    }

    {
        const googleUser = {
            uid: 'g-redirect',
            email: 'river@gmail.com',
            emailVerified: true,
            isAnonymous: false,
            displayName: 'River',
            providerData: [{ providerId: 'google.com' }]
        };
        const { AppAuth, storage } = loadAuth({
            redirectUser: googleUser,
            users: { 'g-redirect': { uid: 'g-redirect', displayName: 'River', nameKey: 'river' } }
        });
        const snap = await AppAuth.init();
        ok(
            'redirect Google sign-in is signed in without typing email',
            snap.signedIn === true && snap.hasGoogle === true && snap.email === 'river@gmail.com',
            JSON.stringify(snap)
        );
        ok(
            'redirect Google sign-in remembers the email for next time',
            storage.getItem('pst_google_login_hint') === 'river@gmail.com',
            storage.getItem('pst_google_login_hint')
        );
    }

    {
        const passwordUser = {
            uid: 'p-redirect',
            email: 'river@gmail.com',
            emailVerified: true,
            isAnonymous: false,
            displayName: 'River',
            providerData: [{ providerId: 'password' }]
        };
        const pendingCred = { providerId: 'google.com', id: 'from-redirect' };
        const redirectErr = new Error('exists');
        redirectErr.code = 'auth/account-exists-with-different-credential';
        redirectErr.email = 'river@gmail.com';
        redirectErr.credential = pendingCred;
        const { AppAuth, linkedCredential } = loadAuth({
            user: passwordUser,
            signedOut: true,
            redirectError: redirectErr,
            signInMethods: ['password'],
            users: { 'p-redirect': { uid: 'p-redirect', displayName: 'River', nameKey: 'river' } }
        });
        const errors = [];
        AppAuth.on('error', (msg) => errors.push(msg));
        const snap = await AppAuth.init();
        ok(
            'redirect account-exists keeps the user signed out',
            snap.signedIn === false && snap.pendingLinkEmail === 'river@gmail.com',
            JSON.stringify(snap)
        );
        ok(
            'redirect account-exists asks for the password',
            errors.some((msg) => /password/i.test(msg)),
            JSON.stringify(errors)
        );
        const linked = await AppAuth.signInEmail('river@gmail.com', 'secret');
        ok('redirect pending Google credential is linked after password', linkedCredential() === pendingCred, JSON.stringify(linkedCredential()));
        ok('redirect linked account is treated as Google', linked.hasGoogle === true && linked.provider === 'google.com', JSON.stringify(linked));
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
