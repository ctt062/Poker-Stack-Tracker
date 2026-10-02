/**
 * Sign-in (Google, Apple, email) and default display name.
 * Rooms reuse this Firebase Auth session; anonymous sign-in is not used.
 */
(function (global) {
    'use strict';

    const DISPLAY_NAME_KEY = 'pst_display_name';
    const SDK_VERSION = '10.14.1';
    const SDK_SCRIPTS = [
        'firebase-app-compat.js',
        'firebase-auth-compat.js',
        'firebase-firestore-compat.js'
    ];

    let auth = null;
    let initialized = false;
    let currentUser = null;
    let sdkPromise = null;
    let firstAuthPromise = null;

    const listeners = {
        user: [],
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

    function loadSdk() {
        if (global.firebase && global.firebase.auth && global.firebase.firestore) {
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

    function friendlyAuthError(err) {
        const code = (err && err.code) || '';
        const map = {
            'auth/popup-closed-by-user': 'Sign-in was cancelled.',
            'auth/cancelled-popup-request': 'Sign-in was cancelled.',
            'auth/popup-blocked': 'The sign-in popup was blocked. Allow popups and try again.',
            'auth/operation-not-allowed': 'That sign-in method is not enabled in Firebase Authentication.',
            'auth/unauthorized-domain': 'This domain is not authorized in Firebase Authentication.',
            'auth/invalid-email': 'Enter a valid email address.',
            'auth/user-disabled': 'This account has been disabled.',
            'auth/user-not-found': 'No account exists for that email. Create one first.',
            'auth/wrong-password': 'Wrong password.',
            'auth/invalid-credential': 'Wrong email or password.',
            'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
            'auth/weak-password': 'Password must be at least 6 characters.',
            'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
            'auth/network-request-failed': 'Network error. Check your connection.',
            'auth/account-exists-with-different-credential': 'That email is already used with a different sign-in method.'
        };
        const message = map[code] || (err && err.message) || 'Sign-in failed.';
        const wrapped = new Error(message);
        wrapped.code = code;
        return wrapped;
    }

    function providerId(user) {
        if (!user || !user.providerData || !user.providerData.length) return '';
        return user.providerData[0].providerId || '';
    }

    function providerLabel(id) {
        if (id === 'google.com') return 'Google';
        if (id === 'apple.com') return 'Apple';
        if (id === 'password') return 'Email';
        return id || '';
    }

    function sanitizeDisplayName(value) {
        return String(value == null ? '' : value).trim().slice(0, 32);
    }

    function normalizeNameKey(name) {
        return sanitizeDisplayName(name).toLowerCase();
    }

    function storageKeyForUid(uid) {
        return uid ? DISPLAY_NAME_KEY + '_' + uid : DISPLAY_NAME_KEY;
    }

    function readLocalName(uid) {
        if (uid) {
            return sanitizeDisplayName(global.localStorage.getItem(storageKeyForUid(uid)));
        }
        return sanitizeDisplayName(global.localStorage.getItem(DISPLAY_NAME_KEY));
    }

    function writeLocalName(uid, name) {
        if (uid) {
            global.localStorage.setItem(storageKeyForUid(uid), name);
            return;
        }
        global.localStorage.setItem(DISPLAY_NAME_KEY, name);
    }

    function getDb() {
        return global.firebase && global.firebase.firestore
            ? global.firebase.firestore()
            : null;
    }

    function getDisplayName() {
        const uid = currentUser && !currentUser.isAnonymous ? currentUser.uid : null;
        return readLocalName(uid);
    }

    function suggestedDisplayName() {
        if (currentUser && currentUser.displayName) {
            return sanitizeDisplayName(currentUser.displayName);
        }
        return '';
    }

    function takenNameError(err) {
        const code = String((err && err.code) || '');
        const msg = String((err && err.message) || '');
        if (msg.indexOf('already taken') !== -1) return err;
        if (code.indexOf('already-exists') !== -1 || code.indexOf('permission') !== -1) {
            return new Error('That display name is already taken');
        }
        return err;
    }

    async function claimDisplayName(trimmed) {
        if (!auth || !auth.currentUser) {
            writeLocalName(null, trimmed);
            return trimmed;
        }
        const uid = auth.currentUser.uid;
        const key = normalizeNameKey(trimmed);
        const db = getDb();
        if (!db) {
            writeLocalName(uid, trimmed);
            return trimmed;
        }

        const newRef = db.collection('displayNames').doc(key);
        const userRef = db.collection('users').doc(uid);

        try {
            await db.runTransaction(async (tx) => {
                const userSnap = await tx.get(userRef);
                const oldName = userSnap.exists
                    ? sanitizeDisplayName(userSnap.data().displayName)
                    : '';
                const oldKey = oldName ? normalizeNameKey(oldName) : '';

                const newSnap = await tx.get(newRef);
                if (newSnap.exists && newSnap.data().uid !== uid) {
                    throw new Error('That display name is already taken');
                }

                if (oldKey && oldKey !== key) {
                    const oldRef = db.collection('displayNames').doc(oldKey);
                    const oldSnap = await tx.get(oldRef);
                    if (oldSnap.exists && oldSnap.data().uid === uid) {
                        tx.delete(oldRef);
                    }
                }

                const payload = {
                    uid: uid,
                    displayName: trimmed,
                    nameKey: key
                };
                tx.set(newRef, payload);
                tx.set(userRef, payload, { merge: true });
            });
        } catch (e) {
            throw takenNameError(e);
        }

        writeLocalName(uid, trimmed);
        try {
            await auth.currentUser.updateProfile({ displayName: trimmed });
        } catch (e) {
            console.warn('updateProfile', e);
        }
        return trimmed;
    }

    async function refreshClaimedName() {
        if (!auth || !auth.currentUser) return;
        const uid = auth.currentUser.uid;
        const db = getDb();
        if (!db) return;
        try {
            const snap = await db.collection('users').doc(uid).get();
            if (snap.exists) {
                const name = sanitizeDisplayName(snap.data().displayName);
                if (name) writeLocalName(uid, name);
            }
            emit('user', snapshot());
        } catch (e) {
            console.warn('refreshClaimedName', e);
        }
    }

    function snapshot() {
        const signedIn = !!(currentUser && !currentUser.isAnonymous);
        return {
            configured: isConfigured(),
            signedIn,
            uid: signedIn ? currentUser.uid : null,
            email: signedIn ? (currentUser.email || '') : '',
            photoURL: signedIn ? (currentUser.photoURL || '') : '',
            provider: signedIn ? providerId(currentUser) : '',
            providerLabel: signedIn ? providerLabel(providerId(currentUser)) : '',
            displayName: getDisplayName()
        };
    }

    function applyUser(user) {
        currentUser = (user && !user.isAnonymous) ? user : null;
        if (user && user.isAnonymous && auth) {
            auth.signOut().catch(() => {});
            currentUser = null;
        }
        emit('user', snapshot());
        if (currentUser) refreshClaimedName();
    }

    async function init() {
        if (!isConfigured()) {
            initialized = true;
            return snapshot();
        }
        if (initialized) return snapshot();
        if (firstAuthPromise) return firstAuthPromise;

        firstAuthPromise = (async () => {
            await loadSdk();
            if (!global.firebase) throw new Error('Firebase SDK not loaded');
            if (!global.firebase.apps.length) {
                global.firebase.initializeApp(global.FIREBASE_CONFIG);
            }
            auth = global.firebase.auth();

            try {
                await auth.getRedirectResult();
            } catch (e) {
                emit('error', friendlyAuthError(e).message);
            }

            await new Promise((resolve) => {
                const unsub = auth.onAuthStateChanged((user) => {
                    applyUser(user);
                    unsub();
                    resolve();
                });
            });

            auth.onAuthStateChanged((user) => applyUser(user));
            initialized = true;
            return snapshot();
        })().catch((e) => {
            firstAuthPromise = null;
            throw e;
        });

        return firstAuthPromise;
    }

    async function ensureAuth() {
        const snap = await init();
        if (!isConfigured()) return snap;
        if (!snap.signedIn) throw new Error('Sign in with Google, Apple, or email first.');
        return snap;
    }

    async function signInWithProvider(provider) {
        await init();
        try {
            const cred = await auth.signInWithPopup(provider);
            applyUser(cred.user);
            return snapshot();
        } catch (e) {
            const code = e && e.code;
            if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
                await auth.signInWithRedirect(provider);
                return snapshot();
            }
            throw friendlyAuthError(e);
        }
    }

    async function signInGoogle() {
        const provider = new global.firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        return signInWithProvider(provider);
    }

    async function signInApple() {
        const provider = new global.firebase.auth.OAuthProvider('apple.com');
        provider.addScope('email');
        provider.addScope('name');
        return signInWithProvider(provider);
    }

    async function signInEmail(email, password) {
        await init();
        try {
            const cred = await auth.signInWithEmailAndPassword(String(email || '').trim(), password);
            applyUser(cred.user);
            return snapshot();
        } catch (e) {
            throw friendlyAuthError(e);
        }
    }

    async function createEmailAccount(email, password) {
        await init();
        try {
            const cred = await auth.createUserWithEmailAndPassword(String(email || '').trim(), password);
            applyUser(cred.user);
            return snapshot();
        } catch (e) {
            throw friendlyAuthError(e);
        }
    }

    async function sendPasswordReset(email) {
        await init();
        const addr = String(email || '').trim();
        if (!addr) throw new Error('Enter your email first.');
        try {
            await auth.sendPasswordResetEmail(addr);
        } catch (e) {
            throw friendlyAuthError(e);
        }
    }

    async function setDisplayName(name) {
        const trimmed = sanitizeDisplayName(name);
        if (!trimmed) throw new Error('Enter a display name');
        if (trimmed.length > 32) throw new Error('Display name must be 32 characters or fewer');
        await claimDisplayName(trimmed);
        emit('user', snapshot());
        return trimmed;
    }

    async function signOut() {
        if (auth) {
            try { await auth.signOut(); } catch (e) { console.warn('signOut', e); }
        }
        currentUser = null;
        emit('user', snapshot());
        return snapshot();
    }

    function getAuth() {
        return auth;
    }

    global.AppAuth = {
        isConfigured,
        loadSdk,
        init,
        ensureAuth,
        getAuth,
        snapshot,
        getDisplayName,
        suggestedDisplayName,
        setDisplayName,
        signInGoogle,
        signInApple,
        signInEmail,
        createEmailAccount,
        sendPasswordReset,
        signOut,
        on
    };
})(window);
