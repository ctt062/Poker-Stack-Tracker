/**
 * Sign-in (Google, email) and default display name.
 * Rooms reuse this Firebase Auth session; anonymous sign-in is not used.
 */
(function (global) {
    'use strict';

    const DISPLAY_NAME_KEY = 'pst_display_name';
    const LOCAL_NAME_EPOCH_KEY = 'pst_display_name_epoch';
    const LOCAL_NAME_EPOCH = '2';
    const GOOGLE_HINT_KEY = 'pst_google_login_hint';
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
    let nextGooglePickAccount = false;
    let pendingLinkCredential = null;
    let pendingLinkEmail = '';

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
            'auth/account-exists-with-different-credential': 'That email already has an account. Sign in with email and password to connect Google.',
            'auth/credential-already-in-use': 'That Google account is already connected to someone else.'
        };
        const message = map[code] || raw || 'Sign-in failed.';
        const wrapped = new Error(message);
        wrapped.code = code;
        if (err && err.email) wrapped.email = err.email;
        if (err && err.credential) wrapped.credential = err.credential;
        return wrapped;
    }

    async function fetchSignInMethods(email) {
        const addr = String(email || '').trim();
        if (!addr || !auth || typeof auth.fetchSignInMethodsForEmail !== 'function') return [];
        try {
            const methods = await auth.fetchSignInMethodsForEmail(addr);
            return Array.isArray(methods) ? methods : [];
        } catch (e) {
            return [];
        }
    }

    async function decorateAuthError(err, extras) {
        const wrapped = friendlyAuthError(err, extras && extras.providerHint);
        const email = String((extras && extras.email) || wrapped.email || '').trim();
        const code = wrapped.code || '';
        if (email && (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found')) {
            const methods = await fetchSignInMethods(email);
            if (methods.indexOf('google.com') !== -1 && methods.indexOf('password') === -1) {
                const next = new Error('This email uses Google. Tap Continue with Google.');
                next.code = code;
                next.email = email;
                return next;
            }
        }
        if (email) wrapped.email = email;
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

    function hasGoogleProvider(user) {
        return !!(user && Array.isArray(user.providerData) &&
            user.providerData.some((p) => p && p.providerId === 'google.com'));
    }

    function providerId(user) {
        if (hasGoogleProvider(user)) return 'google.com';
        if (!user || !user.providerData || !user.providerData.length) return '';
        return user.providerData[0].providerId || '';
    }

    function providerLabel(id) {
        if (id === 'google.com') return 'Google';
        if (id === 'password') return 'Email';
        return id || '';
    }

    function verificationActionCodeSettings() {
        try {
            if (!global.location || !global.location.origin) return undefined;
            const path = global.location.pathname || '/';
            return { url: global.location.origin + path, handleCodeInApp: false };
        } catch (e) {
            return undefined;
        }
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
            hasGoogle: signedIn ? hasGoogleProvider(currentUser) : false,
            emailVerified: signedIn ? !!currentUser.emailVerified : false,
            displayName: getDisplayName(),
            pendingLinkEmail: pendingLinkEmail || ''
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
            if (epoch === nameEpoch && next.emailVerified && !registryName && providerId(next) === 'password') {
                const pending = readLocalName(next.uid);
                if (pending) {
                    try {
                        await claimDisplayName(pending);
                    } catch (e) {
                        if (!e || !/already taken/i.test(String(e.message || ''))) {
                            console.warn('claimPendingName', e);
                        }
                    }
                }
            }
        } else if (epoch === nameEpoch) {
            currentUser = null;
            registryName = '';
        }
        if (next && currentUser !== next) return;
        if (!next && epoch !== nameEpoch) return;
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
                if (redirect && redirect.user) {
                    await applyUser(redirect.user);
                    if (redirect.user.email) rememberGoogleHint(redirect.user.email);
                    pendingLinkCredential = null;
                    pendingLinkEmail = '';
                }
            } catch (e) {
                const handled = await capturePendingGoogleLink(e);
                emit('error', handled.message);
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
        if (!snap.signedIn) throw new Error('Sign in with Google or email first.');
        if (!snap.hasGoogle && snap.provider !== 'google.com' && !snap.emailVerified) {
            throw new Error('Verify your email first.');
        }
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

    function rememberGoogleHint(email) {
        const addr = String(email || '').trim();
        if (!addr) return;
        try {
            global.localStorage.setItem(GOOGLE_HINT_KEY, addr);
        } catch (e) { /* ignore */ }
    }

    function storedGoogleHint() {
        try {
            return String(global.localStorage.getItem(GOOGLE_HINT_KEY) || '').trim();
        } catch (e) {
            return '';
        }
    }

    function buildGoogleProvider(options) {
        const AuthNS = requireAuthSdk();
        if (typeof AuthNS.GoogleAuthProvider !== 'function') {
            throw new Error('Could not reach Firebase. Check your connection and try again.');
        }
        const provider = new AuthNS.GoogleAuthProvider();
        provider.addScope('email');
        provider.addScope('profile');
        const pick = !!(options && options.pickAccount) || nextGooglePickAccount;
        nextGooglePickAccount = false;
        const params = {};
        if (pick) params.prompt = 'select_account';
        const hint = String((options && options.loginHint) || storedGoogleHint() || '').trim();
        if (hint && !pick) params.login_hint = hint;
        if (Object.keys(params).length) provider.setCustomParameters(params);
        return provider;
    }

    async function capturePendingGoogleLink(err, fallbackEmail) {
        const wrapped = friendlyAuthError(err);
        if (wrapped.code !== 'auth/account-exists-with-different-credential') {
            return wrapped;
        }
        pendingLinkCredential = wrapped.credential || (err && err.credential) || null;
        pendingLinkEmail = String(
            wrapped.email || (err && err.email) || fallbackEmail || ''
        ).trim();
        const methods = pendingLinkEmail ? await fetchSignInMethods(pendingLinkEmail) : [];
        const next = new Error(
            methods.indexOf('password') !== -1
                ? 'This email already has a password. Sign in with email and password to connect Google.'
                : 'That email already has an account. Sign in with email and password to connect Google.'
        );
        next.code = wrapped.code;
        next.email = pendingLinkEmail;
        return next;
    }

    async function maybeLinkPendingGoogle() {
        if (!pendingLinkCredential || !auth || !auth.currentUser) return;
        const cred = pendingLinkCredential;
        pendingLinkCredential = null;
        pendingLinkEmail = '';
        try {
            await auth.currentUser.linkWithCredential(cred);
        } catch (e) {
            console.warn('linkGoogle', e);
        }
        await applyUser(auth.currentUser);
    }

    async function signInGoogle(options) {
        await init();
        const provider = buildGoogleProvider(options);
        try {
            const snap = await signInWithProvider(provider, 'google.com');
            if (snap && snap.email) rememberGoogleHint(snap.email);
            pendingLinkCredential = null;
            pendingLinkEmail = '';
            return snap;
        } catch (e) {
            throw await capturePendingGoogleLink(e, options && options.loginHint);
        }
    }

    async function linkGoogle(options) {
        await init();
        if (!auth || !auth.currentUser) throw new Error('Sign in first.');
        const provider = buildGoogleProvider(options);
        try {
            if (shouldUseRedirect() && typeof auth.currentUser.linkWithRedirect === 'function') {
                await auth.currentUser.linkWithRedirect(provider);
                return snapshot();
            }
            const cred = await auth.currentUser.linkWithPopup(provider);
            await applyUser(cred.user || auth.currentUser);
            const snap = snapshot();
            if (snap.email) rememberGoogleHint(snap.email);
            return snap;
        } catch (e) {
            throw await decorateAuthError(e, { providerHint: 'google.com' });
        }
    }

    async function signInEmail(email, password) {
        await init();
        const addr = String(email || '').trim();
        try {
            const cred = await auth.signInWithEmailAndPassword(addr, password);
            await applyUser(cred.user);
            await maybeLinkPendingGoogle();
            return snapshot();
        } catch (e) {
            throw await decorateAuthError(e, { email: addr });
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
            const settings = verificationActionCodeSettings();
            try {
                if (settings) await cred.user.sendEmailVerification(settings);
                else await cred.user.sendEmailVerification();
            } catch (verifyErr) {
                console.warn('sendEmailVerification', verifyErr);
            }
            writeLocalName(cred.user.uid, trimmed);
            try {
                await cred.user.updateProfile({ displayName: trimmed });
            } catch (e) {
                console.warn('updateProfile', e);
            }
            await applyUser(cred.user);
            return snapshot();
        } catch (e) {
            throw friendlyAuthError(e);
        } finally {
            applyHeld = false;
        }
    }

    async function refreshEmailVerification() {
        await init();
        if (!auth || !auth.currentUser) return snapshot();
        applyHeld = true;
        try {
            try {
                await auth.currentUser.reload();
            } catch (e) {
                throw friendlyAuthError(e);
            }
            await applyUser(auth.currentUser);
            return snapshot();
        } finally {
            applyHeld = false;
        }
    }

    async function sendEmailVerification() {
        await init();
        if (!auth || !auth.currentUser) throw new Error('Sign in first.');
        if (auth.currentUser.emailVerified) return snapshot();
        try {
            const settings = verificationActionCodeSettings();
            if (settings) await auth.currentUser.sendEmailVerification(settings);
            else await auth.currentUser.sendEmailVerification();
        } catch (e) {
            throw friendlyAuthError(e);
        }
        return snapshot();
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

    async function signOut(options) {
        if (options && options.pickNextGoogleAccount) nextGooglePickAccount = true;
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
        linkGoogle,
        signInEmail,
        createEmailAccount,
        refreshEmailVerification,
        sendEmailVerification,
        sendPasswordReset,
        signOut,
        on
    };
})(window);
