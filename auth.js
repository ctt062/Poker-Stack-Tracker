/**
 * Sign-in (Google, Apple, email) and default display name.
 * Rooms reuse this Firebase Auth session; anonymous sign-in is not used.
 */
(function (global) {
    'use strict';

    const DISPLAY_NAME_KEY = 'pst_display_name';
    const LOCAL_NAME_EPOCH_KEY = 'pst_display_name_epoch';
    const LOCAL_NAME_EPOCH = '2';
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
    let registryName = '';
    let nameEpoch = 0;
    let applyHeld = false;

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

    function friendlyAuthError(err, providerHint) {
        const code = (err && err.code) || '';
        const raw = String((err && err.message) || '');
        if (/code flow is not enabled for apple/i.test(raw) || providerHint === 'apple.com' && code === 'auth/operation-not-allowed') {
            const wrapped = new Error('Apple Sign-In needs an Apple Developer Services ID and key in Firebase Authentication. Use Google or email until that is set up.');
            wrapped.code = code;
            return wrapped;
        }
        const map = {
            'auth/popup-closed-by-user': 'Sign-in was cancelled.',
            'auth/cancelled-popup-request': 'Sign-in was cancelled.',
            'auth/popup-blocked': 'The sign-in popup was blocked. Allow popups, or the app will try a full-page redirect.',
            'auth/operation-not-allowed': 'That sign-in method is not enabled in Firebase Authentication.',
            'auth/unauthorized-domain': 'This domain is not authorized in Firebase Authentication.',
            'auth/invalid-email': 'Enter a valid email address.',
            'auth/user-disabled': 'This account has been disabled.',
            'auth/user-not-found': 'No account exists for that email. Create one first.',
            'auth/wrong-password': 'Wrong password.',
            'auth/invalid-credential': 'Wrong email or password.',
            'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
            'auth/weak-password': 'Password must be at least 6 characters.',
            'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
            'auth/network-request-failed': 'Network error. Check your connection.',
            'auth/account-exists-with-different-credential': 'That email is already used with a different sign-in method.'
        };
        const message = map[code] || raw || 'Sign-in failed.';
        const wrapped = new Error(message);
        wrapped.code = code;
        return wrapped;
    }

    function shouldUseRedirect() {
        if (typeof navigator === 'undefined') return false;
        const ua = navigator.userAgent || '';
        const iOS = /iPad|iPhone|iPod/.test(ua) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
            navigator.standalone === true;
        return iOS || standalone;
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

    function clearLocalName(uid) {
        try {
            if (uid) global.localStorage.removeItem(storageKeyForUid(uid));
            global.localStorage.removeItem(DISPLAY_NAME_KEY);
        } catch (e) { /* ignore */ }
    }

    function purgeLegacyLocalNames() {
        try {
            if (global.localStorage.getItem(LOCAL_NAME_EPOCH_KEY) === LOCAL_NAME_EPOCH) return;
            const keys = [];
            for (let i = 0; i < global.localStorage.length; i++) {
                const k = global.localStorage.key(i);
                if (k === DISPLAY_NAME_KEY || (k && k.indexOf(DISPLAY_NAME_KEY + '_') === 0)) {
                    keys.push(k);
                }
            }
            keys.forEach((k) => global.localStorage.removeItem(k));
            global.localStorage.setItem(LOCAL_NAME_EPOCH_KEY, LOCAL_NAME_EPOCH);
        } catch (e) { /* ignore */ }
    }

    function requireAuthSdk() {
        if (!global.firebase || typeof global.firebase.auth !== 'function') {
            throw new Error('Could not reach Firebase. Check your connection and try again.');
        }
        return global.firebase.auth;
    }

    function getDb() {
        return global.firebase && global.firebase.firestore
            ? global.firebase.firestore()
            : null;
    }

    function getDisplayName() {
        if (currentUser) return registryName;
        return registryName || readLocalName(null);
    }

    function suggestedDisplayName() {
        if (currentUser && currentUser.displayName) {
            const fromProfile = sanitizeDisplayName(currentUser.displayName);
            if (fromProfile) return fromProfile;
        }
        const uid = currentUser && !currentUser.isAnonymous ? currentUser.uid : null;
        return readLocalName(uid);
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
            nameEpoch += 1;
            registryName = trimmed;
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

        nameEpoch += 1;
        registryName = trimmed;
        writeLocalName(uid, trimmed);
        try {
            await auth.currentUser.updateProfile({ displayName: trimmed });
        } catch (e) {
            console.warn('updateProfile', e);
        }
        return trimmed;
    }

    async function refreshClaimedName(epoch) {
        if (!auth || !auth.currentUser) {
            if (epoch === nameEpoch) registryName = '';
            return;
        }
        const uid = auth.currentUser.uid;
        const db = getDb();
        if (!db) return;
        try {
            const snap = await db.collection('users').doc(uid).get();
            if (epoch !== nameEpoch) return;
            const name = snap.exists
                ? sanitizeDisplayName(snap.data().displayName)
                : '';
            if (!name) {
                if (registryName) return;
                registryName = '';
                clearLocalName(uid);
                return;
            }
            registryName = name;
            writeLocalName(uid, name);
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

    async function applyUser(user) {
        const epoch = ++nameEpoch;
        const next = (user && !user.isAnonymous) ? user : null;
        if (user && user.isAnonymous && auth) {
            auth.signOut().catch(() => {});
        }
        if (next) {
            if (!currentUser || currentUser.uid !== next.uid) {
                registryName = '';
            }
            currentUser = next;
            await refreshClaimedName(epoch);
        } else if (epoch === nameEpoch) {
            currentUser = null;
            registryName = '';
        }
        if (epoch !== nameEpoch) return;
        emit('user', snapshot());
    }

    function applyUserFromObserver(user) {
        if (applyHeld) return Promise.resolve();
        return applyUser(user);
    }

    async function init() {
        if (!isConfigured()) {
            initialized = true;
            return snapshot();
        }
        if (initialized) return snapshot();
        if (firstAuthPromise) return firstAuthPromise;

        firstAuthPromise = (async () => {
            purgeLegacyLocalNames();
            await loadSdk();
            requireAuthSdk();
            if (!global.firebase.apps.length) {
                global.firebase.initializeApp(global.FIREBASE_CONFIG);
            }
            auth = global.firebase.auth();
            if (typeof auth.useDeviceLanguage === 'function') {
                auth.useDeviceLanguage();
            }

            try {
                const redirect = await auth.getRedirectResult();
                if (redirect && redirect.user) await applyUser(redirect.user);
            } catch (e) {
                emit('error', friendlyAuthError(e).message);
            }

            await new Promise((resolve) => {
                const unsub = auth.onAuthStateChanged((user) => {
                    applyUserFromObserver(user).finally(() => {
                        unsub();
                        resolve();
                    });
                });
            });

            auth.onAuthStateChanged((user) => {
                applyUserFromObserver(user).catch((e) => console.warn('applyUser', e));
            });
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

    async function signInWithProvider(provider, providerId) {
        await init();
        const redirectFirst = shouldUseRedirect();
        try {
            if (redirectFirst) {
                await auth.signInWithRedirect(provider);
                return snapshot();
            }
            const cred = await auth.signInWithPopup(provider);
            await applyUser(cred.user);
            return snapshot();
        } catch (e) {
            const code = e && e.code;
            const canRedirect = code === 'auth/popup-blocked' ||
                code === 'auth/operation-not-supported-in-this-environment' ||
                code === 'auth/cancelled-popup-request';
            if (!redirectFirst && canRedirect) {
                await auth.signInWithRedirect(provider);
                return snapshot();
            }
            throw friendlyAuthError(e, providerId);
        }
    }

    async function signInGoogle() {
        await init();
        const AuthNS = requireAuthSdk();
        if (typeof AuthNS.GoogleAuthProvider !== 'function') {
            throw new Error('Could not reach Firebase. Check your connection and try again.');
        }
        const provider = new AuthNS.GoogleAuthProvider();
        provider.addScope('email');
        provider.addScope('profile');
        provider.setCustomParameters({ prompt: 'select_account' });
        return signInWithProvider(provider, 'google.com');
    }

    async function signInApple() {
        await init();
        const AuthNS = requireAuthSdk();
        if (typeof AuthNS.OAuthProvider !== 'function') {
            throw new Error('Could not reach Firebase. Check your connection and try again.');
        }
        const provider = new AuthNS.OAuthProvider('apple.com');
        provider.addScope('email');
        provider.addScope('name');
        return signInWithProvider(provider, 'apple.com');
    }

    async function signInEmail(email, password) {
        await init();
        try {
            const cred = await auth.signInWithEmailAndPassword(String(email || '').trim(), password);
            await applyUser(cred.user);
            return snapshot();
        } catch (e) {
            throw friendlyAuthError(e);
        }
    }

    async function createEmailAccount(email, password, displayName) {
        await init();
        const trimmed = sanitizeDisplayName(displayName);
        if (!trimmed) throw new Error('Enter a display name');
        applyHeld = true;
        try {
            const cred = await auth.createUserWithEmailAndPassword(String(email || '').trim(), password);
            currentUser = (cred.user && !cred.user.isAnonymous) ? cred.user : null;
            try {
                await claimDisplayName(trimmed);
            } catch (nameErr) {
                await applyUser(cred.user);
                throw nameErr;
            }
            await applyUser(cred.user);
            return snapshot();
        } catch (e) {
            if (e && !e.code && /already taken|display name/i.test(String(e.message || ''))) {
                throw e;
            }
            throw friendlyAuthError(e);
        } finally {
            applyHeld = false;
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
        nameEpoch += 1;
        if (auth) {
            try { await auth.signOut(); } catch (e) { console.warn('signOut', e); }
        }
        currentUser = null;
        registryName = '';
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
