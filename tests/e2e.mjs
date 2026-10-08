#!/usr/bin/env node
/**
 * Behavioral tests against the running app in headless Chrome.
 * Asserts observable UI, not source text.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EVIDENCE = process.env.EVIDENCE_DIR
    || '/Users/ctt/.no-mistakes/evidence/01M3XMXAD8AVY76N0KY14G8XKJ';

const require = createRequire(import.meta.url);
let puppeteer;
try {
    puppeteer = require('puppeteer-core');
} catch (e) {
    console.error('Install test deps first: npm install');
    process.exit(1);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.md': 'text/markdown; charset=utf-8'
};

const EMPTY_FIREBASE = 'window.FIREBASE_CONFIG = { apiKey: "", projectId: "", appId: "" };';

function startServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
        if (url.pathname === '/' || url.pathname.endsWith('/')) {
            filePath = path.join(ROOT, 'index.html');
        }
        const rel = path.relative(ROOT, filePath);
        if (rel.startsWith('..')) {
            res.writeHead(403);
            res.end();
            return;
        }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
            res.end(data);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
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

async function shot(page, name) {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const file = path.join(EVIDENCE, name);
    await page.screenshot({ path: file, fullPage: true });
    console.log('SHOT', file);
    return file;
}

async function withPage(browser, fn, viewport) {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    if (viewport) await page.setViewport(viewport);
    else await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    try {
        await fn(page);
    } catch (err) {
        try { await shot(page, 'failure.png'); } catch (e) { /* ignore */ }
        throw err;
    } finally {
        await page.close();
    }
}

async function interceptEmptyFirebase(page) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (req.url().includes('firebase-config.js')) {
            req.respond({
                status: 200,
                contentType: 'application/javascript',
                body: EMPTY_FIREBASE
            });
            return;
        }
        req.continue();
    });
}

async function gotoApp(page, origin) {
    await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
}

async function tap(page, selector) {
    await page.waitForSelector(selector);
    await page.$eval(selector, (el) => {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.click();
    });
}

async function addPlayer(page, name, buyIn) {
    await tap(page, '#addPlayerBtn');
    await page.waitForSelector('#playerModal', { visible: true });
    await page.$eval('#playerName', (el, n) => { el.value = n; }, name);
    await page.$eval('#playerBuyIn', (el, n) => { el.value = String(n); }, buyIn);
    await page.click('#playerForm button[type="submit"]');
    await page.waitForFunction(() => {
        const modal = document.getElementById('playerModal');
        return !modal || modal.style.display === 'none';
    });
}

async function waitAuthGate(page) {
    await page.waitForFunction(() => {
        const gate = document.getElementById('authGate');
        if (!gate) return false;
        return getComputedStyle(gate).display === 'flex';
    });
}

async function run() {
    const { server, port } = await startServer();
    const origin = `http://127.0.0.1:${port}`;
    const chromeExists = fs.existsSync(CHROME);
    if (!chromeExists) {
        console.error('Google Chrome not found at', CHROME);
        server.close();
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu']
    });

    async function scenario(name, fn, viewport) {
        try {
            await withPage(browser, fn, viewport);
        } catch (err) {
            ok(name, false, err && err.message);
        }
    }

    try {
        await scenario('auth gate', async (page) => {
            await gotoApp(page, origin);
            await waitAuthGate(page);
            const gate = await page.evaluate(() => {
                const style = getComputedStyle(document.getElementById('authGate'));
                return {
                    pending: document.documentElement.classList.contains('auth-pending'),
                    display: style.display,
                    google: (document.getElementById('authGoogleBtn') || {}).textContent || '',
                    apple: !!document.getElementById('authAppleBtn'),
                    email: !!document.getElementById('authEmail'),
                    password: !!document.getElementById('authPassword'),
                    create: (document.getElementById('authEmailCreate') || {}).textContent || '',
                    forgot: (document.getElementById('authForgot') || {}).textContent || '',
                    createPanelHidden: (document.getElementById('authCreatePanel') || {}).hidden,
                    confirmOnSignIn: !!document.getElementById('authCreatePasswordConfirm')
                        && document.getElementById('authCreatePasswordConfirm').offsetParent !== null,
                    guest: !!Array.from(document.querySelectorAll('button, a')).find((el) =>
                        /anonymous|guest|continue without/i.test(el.textContent || ''))
                };
            });
            ok('auth gate pending with Firebase config', gate.pending);
            ok('auth gate visible', gate.display === 'flex', gate.display);
            ok('Google sign-in present', /google/i.test(gate.google), gate.google);
            ok('Apple sign-in is not offered', gate.apple === false, JSON.stringify(gate));
            ok('email sign-in present', gate.email && gate.password, JSON.stringify(gate));
            ok('create account is a switch, not a shared submit', /create/i.test(gate.create) && gate.createPanelHidden === true, JSON.stringify(gate));
            ok('confirm password is not on the sign-in panel', gate.confirmOnSignIn === false, JSON.stringify(gate));
            ok('forgot password present', /forgot/i.test(gate.forgot), gate.forgot);
            ok('no anonymous/guest continue', gate.guest === false);
            await shot(page, 'auth-gate-desktop.png');

            await page.click('#authForgot');
            await page.waitForFunction(() => {
                const el = document.getElementById('authError');
                return el && !el.hidden && (el.textContent || '').trim().length > 0;
            });
            const forgotMsg = await page.$eval('#authError', (el) => el.textContent);
            ok('forgot password without email asks for email', /enter your email first/i.test(forgotMsg), forgotMsg);
            await shot(page, 'auth-forgot-empty-email.png');

            await page.$eval('#authEmail', (el) => { el.value = 'river@example.com'; });
            await page.click('#authEmailCreate');
            await page.waitForFunction(() => {
                const create = document.getElementById('authCreatePanel');
                const signIn = document.getElementById('authSignInPanel');
                return create && !create.hidden && signIn && signIn.hidden;
            });
            const createPanel = await page.evaluate(() => {
                const create = document.getElementById('authCreatePanel');
                const signIn = document.getElementById('authSignInPanel');
                return {
                    createVisible: create && !create.hidden,
                    signInHidden: signIn ? signIn.hidden : null,
                    email: (document.getElementById('authCreateEmail') || {}).value || '',
                    password: !!document.getElementById('authCreatePassword'),
                    confirm: !!document.getElementById('authCreatePasswordConfirm'),
                    displayName: !!document.getElementById('authCreateDisplayName'),
                    submit: (document.getElementById('authCreateSubmit') || {}).textContent || '',
                    back: (document.getElementById('authShowSignIn') || {}).textContent || '',
                    googleOnCreate: document.getElementById('authGoogleBtn')
                        && document.getElementById('authGoogleBtn').offsetParent !== null
                };
            });
            ok('create panel is its own step', createPanel.createVisible && createPanel.signInHidden === true, JSON.stringify(createPanel));
            ok('create copies email from sign-in', createPanel.email === 'river@example.com', createPanel.email);
            ok('create asks for password, confirm, and display name', createPanel.password && createPanel.confirm && createPanel.displayName, JSON.stringify(createPanel));
            ok('create submit is Create account', /create account/i.test(createPanel.submit), createPanel.submit);
            ok('create can switch back to sign in', /sign in/i.test(createPanel.back), createPanel.back);
            ok('Google stays on the sign-in panel', createPanel.googleOnCreate === false, JSON.stringify(createPanel));
            await shot(page, 'auth-create-panel.png');

            await page.$eval('#authCreatePassword', (el) => { el.value = 'secret1'; });
            await page.$eval('#authCreatePasswordConfirm', (el) => { el.value = 'secret2'; });
            await page.$eval('#authCreateDisplayName', (el) => { el.value = 'River'; });
            await page.click('#authCreateSubmit');
            await page.waitForFunction(() => {
                const el = document.getElementById('authError');
                return el && !el.hidden && /passwords do not match/i.test(el.textContent || '');
            });
            const mismatch = await page.$eval('#authError', (el) => el.textContent);
            ok('create rejects mismatched passwords', /passwords do not match/i.test(mismatch), mismatch);
            await shot(page, 'auth-create-mismatch.png');

            await page.click('#authShowSignIn');
            await page.waitForFunction(() => {
                const signIn = document.getElementById('authSignInPanel');
                const create = document.getElementById('authCreatePanel');
                return signIn && !signIn.hidden && create && create.hidden;
            });
            const backEmail = await page.$eval('#authEmail', (el) => el.value);
            ok('sign-in copies email back from create', backEmail === 'river@example.com', backEmail);
        });

        await scenario('google sign-in before SDK does not crash', async (page) => {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (req.url().includes('gstatic.com/firebasejs')) {
                    req.abort('failed');
                    return;
                }
                req.continue();
            });
            await gotoApp(page, origin);
            await waitAuthGate(page);
            await page.waitForFunction(() => {
                const btn = document.getElementById('authGoogleBtn');
                return btn && !btn.disabled;
            });
            await page.evaluate(() => {
                const el = document.getElementById('authError');
                if (el) {
                    el.hidden = true;
                    el.textContent = '';
                }
            });
            await page.click('#authGoogleBtn');
            await page.waitForFunction(() => {
                const el = document.getElementById('authError');
                return el && !el.hidden && (el.textContent || '').trim().length > 0;
            });
            const text = await page.$eval('#authError', (el) => el.textContent || '');
            ok(
                'google click without SDK is a friendly error',
                /could not reach firebase/i.test(text),
                text
            );
            ok(
                'google click without SDK does not crash on undefined auth',
                !/undefined \(reading 'auth'\)/i.test(text),
                text
            );
            await shot(page, 'auth-google-before-sdk.png');
        });

        await scenario('auth gate mobile', async (page) => {
            await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
            await gotoApp(page, origin);
            await waitAuthGate(page);
            await shot(page, 'auth-gate-mobile.png');
            const visible = await page.evaluate(() => getComputedStyle(document.getElementById('authGate')).display);
            ok('auth gate visible on mobile', visible === 'flex', visible);
            await page.click('#authEmailCreate');
            await page.waitForFunction(() => {
                const create = document.getElementById('authCreatePanel');
                return create && !create.hidden;
            });
            await shot(page, 'auth-create-mobile.png');
            const createVisible = await page.evaluate(() => {
                const create = document.getElementById('authCreatePanel');
                const card = document.querySelector('.auth-card');
                const rect = card ? card.getBoundingClientRect() : null;
                return {
                    hidden: create ? create.hidden : null,
                    cardTop: rect ? Math.round(rect.top) : null,
                    cardBottom: rect ? Math.round(rect.bottom) : null,
                    viewHeight: window.innerHeight
                };
            });
            ok('create panel opens on mobile', createVisible.hidden === false, JSON.stringify(createVisible));
            ok(
                'create card stays on screen on mobile',
                createVisible.cardTop >= 0 && createVisible.cardBottom <= createVisible.viewHeight + 40,
                JSON.stringify(createVisible)
            );
        });

        await scenario('sign-out after create returns to empty sign-in', async (page) => {
            await gotoApp(page, origin);
            await waitAuthGate(page);
            await page.waitForFunction(() => typeof applyAuthSnapshot === 'function' && window.AppAuth);
            await page.evaluate(async () => {
                try { await AppAuth.init(); } catch (e) { /* gate still works if SDK is unreachable */ }
            });
            await page.click('#authEmailCreate');
            await page.waitForFunction(() => {
                const create = document.getElementById('authCreatePanel');
                return create && !create.hidden;
            });
            await page.$eval('#authCreateEmail', (el) => { el.value = 'alice@example.com'; });
            await page.$eval('#authCreatePassword', (el) => { el.value = 'secret1'; });
            await page.$eval('#authCreatePasswordConfirm', (el) => { el.value = 'secret1'; });
            await page.$eval('#authCreateDisplayName', (el) => { el.value = 'Alice'; });
            await page.$eval('#authDisplayNameInput', (el) => { el.value = 'Alice'; });

            await page.evaluate(() => {
                applyAuthSnapshot({ configured: true, signedIn: false, displayName: '' });
            });
            const inProgress = await page.evaluate(() => ({
                createHidden: (document.getElementById('authCreatePanel') || {}).hidden,
                email: (document.getElementById('authCreateEmail') || {}).value || '',
                password: (document.getElementById('authCreatePassword') || {}).value || '',
                confirm: (document.getElementById('authCreatePasswordConfirm') || {}).value || '',
                name: (document.getElementById('authCreateDisplayName') || {}).value || ''
            }));
            ok(
                'signed-out snapshot keeps in-progress create panel',
                inProgress.createHidden === false
                    && inProgress.email === 'alice@example.com'
                    && inProgress.password === 'secret1'
                    && inProgress.confirm === 'secret1'
                    && inProgress.name === 'Alice',
                JSON.stringify(inProgress)
            );

            await page.evaluate(() => {
                applyAuthSnapshot({
                    configured: true,
                    signedIn: true,
                    displayName: 'Alice',
                    email: 'alice@example.com',
                    emailVerified: false,
                    provider: 'password',
                    providerLabel: 'Email'
                });
            });
            await page.waitForFunction(() => {
                const verify = document.getElementById('authVerifyPanel');
                return verify && !verify.hidden
                    && document.documentElement.classList.contains('auth-pending');
            });
            const verifyPanel = await page.evaluate(() => {
                const verify = document.getElementById('authVerifyPanel');
                const lead = document.getElementById('authVerifyLead');
                return {
                    visible: verify && !verify.hidden,
                    lead: lead ? lead.textContent : '',
                    continueBtn: (document.getElementById('authVerifyContinue') || {}).textContent || '',
                    resend: (document.getElementById('authVerifyResend') || {}).textContent || '',
                    createHidden: (document.getElementById('authCreatePanel') || {}).hidden
                };
            });
            ok(
                'unverified email account is held on the verify panel',
                verifyPanel.visible && verifyPanel.createHidden === true
                    && /alice@example.com/i.test(verifyPanel.lead)
                    && /verified/i.test(verifyPanel.continueBtn)
                    && /resend/i.test(verifyPanel.resend),
                JSON.stringify(verifyPanel)
            );
            await shot(page, 'auth-verify-email.png');

            await page.evaluate(() => {
                AppAuth.refreshEmailVerification = async () => ({
                    configured: true,
                    signedIn: true,
                    displayName: 'Alice',
                    email: 'alice@example.com',
                    emailVerified: false,
                    provider: 'password',
                    providerLabel: 'Email'
                });
            });
            await page.click('#authVerifyContinue');
            await page.waitForFunction(() => {
                const el = document.getElementById('authError');
                return el && !el.hidden && /verification link/i.test(el.textContent || '');
            });
            const stillUnverified = await page.$eval('#authError', (el) => el.textContent);
            ok('continue without verifying asks to open the email link', /verification link/i.test(stillUnverified), stillUnverified);

            await page.evaluate(() => {
                applyAuthSnapshot({
                    configured: true,
                    signedIn: true,
                    displayName: 'Alice',
                    email: 'alice@example.com',
                    emailVerified: true,
                    provider: 'password',
                    providerLabel: 'Email'
                });
            });
            await page.waitForFunction(() => {
                const gate = document.getElementById('authGate');
                return gate && getComputedStyle(gate).display === 'none'
                    && !document.documentElement.classList.contains('auth-pending');
            });

            await page.evaluate(() => {
                applyAuthSnapshot({ configured: true, signedIn: false, displayName: '' });
            });
            await page.waitForFunction(() => {
                const signIn = document.getElementById('authSignInPanel');
                const create = document.getElementById('authCreatePanel');
                return signIn && !signIn.hidden && create && create.hidden
                    && document.documentElement.classList.contains('auth-pending');
            });
            const afterUnlockSignOut = await page.evaluate(() => ({
                signInHidden: (document.getElementById('authSignInPanel') || {}).hidden,
                createHidden: (document.getElementById('authCreatePanel') || {}).hidden,
                nameHidden: (document.getElementById('authDisplayNamePanel') || {}).hidden,
                pending: document.documentElement.classList.contains('auth-pending'),
                nameInput: (document.getElementById('authDisplayNameInput') || {}).value || '',
                createEmail: (document.getElementById('authCreateEmail') || {}).value || '',
                createPassword: (document.getElementById('authCreatePassword') || {}).value || '',
                createConfirm: (document.getElementById('authCreatePasswordConfirm') || {}).value || '',
                createName: (document.getElementById('authCreateDisplayName') || {}).value || ''
            }));
            ok(
                'sign-out after create shows sign-in',
                afterUnlockSignOut.signInHidden === false
                    && afterUnlockSignOut.createHidden === true
                    && afterUnlockSignOut.nameHidden === true
                    && afterUnlockSignOut.pending,
                JSON.stringify(afterUnlockSignOut)
            );
            ok(
                'sign-out after create clears create fields',
                afterUnlockSignOut.nameInput === ''
                    && afterUnlockSignOut.createEmail === ''
                    && afterUnlockSignOut.createPassword === ''
                    && afterUnlockSignOut.createConfirm === ''
                    && afterUnlockSignOut.createName === '',
                JSON.stringify(afterUnlockSignOut)
            );

            await page.click('#authEmailCreate');
            await page.waitForFunction(() => {
                const create = document.getElementById('authCreatePanel');
                return create && !create.hidden;
            });
            const reused = await page.evaluate(() => ({
                password: (document.getElementById('authCreatePassword') || {}).value || '',
                confirm: (document.getElementById('authCreatePasswordConfirm') || {}).value || '',
                name: (document.getElementById('authCreateDisplayName') || {}).value || ''
            }));
            ok(
                'create after sign-out does not reuse leftover credentials',
                reused.password === '' && reused.confirm === '' && reused.name === '',
                JSON.stringify(reused)
            );
        });

        await scenario('display name gate and room rake', async (page) => {
            await gotoApp(page, origin);
            await waitAuthGate(page);
            await page.waitForFunction(() => typeof applyAuthSnapshot === 'function' && window.AppAuth);
            await page.evaluate(async () => {
                try { await AppAuth.init(); } catch (e) { /* gate still works if SDK is unreachable */ }
            });
            await page.evaluate(() => {
                applyAuthSnapshot({
                    configured: true,
                    signedIn: true,
                    displayName: '',
                    emailVerified: false,
                    provider: 'google.com'
                });
            });
            await page.waitForFunction(() => {
                const panel = document.getElementById('authDisplayNamePanel');
                const verify = document.getElementById('authVerifyPanel');
                return panel && !panel.hidden && verify && verify.hidden;
            });
            const googleSkipsVerify = await page.evaluate(() => ({
                nameVisible: !(document.getElementById('authDisplayNamePanel') || {}).hidden,
                verifyHidden: (document.getElementById('authVerifyPanel') || {}).hidden
            }));
            ok(
                'Google skips the email verify panel',
                googleSkipsVerify.nameVisible === true && googleSkipsVerify.verifyHidden === true,
                JSON.stringify(googleSkipsVerify)
            );
            await page.evaluate(() => {
                applyAuthSnapshot({
                    configured: true,
                    signedIn: true,
                    displayName: '',
                    emailVerified: true,
                    provider: 'google.com'
                });
            });
            await page.waitForFunction(() => {
                const panel = document.getElementById('authDisplayNamePanel');
                return panel && !panel.hidden;
            });
            const nameGate = await page.evaluate(() => {
                const panel = document.getElementById('authDisplayNamePanel');
                const signIn = document.getElementById('authSignInPanel');
                const gate = getComputedStyle(document.getElementById('authGate'));
                return {
                    nameVisible: panel && !panel.hidden,
                    signInHidden: signIn ? signIn.hidden : null,
                    gate: gate.display,
                    pending: document.documentElement.classList.contains('auth-pending')
                };
            });
            ok('display name required after sign-in', nameGate.nameVisible && nameGate.gate === 'flex' && nameGate.pending, JSON.stringify(nameGate));
            ok('sign-in panel hidden on name gate', nameGate.signInHidden === true, JSON.stringify(nameGate));
            const nameSignOut = await page.evaluate(() => {
                const btn = document.getElementById('authNameSignOut');
                const create = document.getElementById('authCreatePanel');
                return {
                    label: btn ? btn.textContent : '',
                    createHidden: create ? create.hidden : null
                };
            });
            ok('name gate can switch accounts', /different account/i.test(nameSignOut.label), JSON.stringify(nameSignOut));
            ok('create panel hidden on name gate', nameSignOut.createHidden === true, JSON.stringify(nameSignOut));
            await shot(page, 'auth-display-name-gate.png');

            await page.evaluate(() => {
                AppAuth.signOut = async () => ({ configured: true, signedIn: false, displayName: '' });
            });
            await page.$eval('#authDisplayNameInput', (el) => { el.value = 'Alice'; });
            await page.$eval('#authCreateEmail', (el) => { el.value = 'alice@example.com'; });
            await page.$eval('#authCreatePassword', (el) => { el.value = 'secret1'; });
            await page.$eval('#authCreatePasswordConfirm', (el) => { el.value = 'secret1'; });
            await page.$eval('#authCreateDisplayName', (el) => { el.value = 'Alice'; });
            await page.click('#authNameSignOut');
            await page.waitForFunction(() => {
                const signIn = document.getElementById('authSignInPanel');
                const namePanel = document.getElementById('authDisplayNamePanel');
                return signIn && !signIn.hidden && namePanel && namePanel.hidden;
            });
            const afterNameSignOut = await page.evaluate(() => ({
                signInHidden: (document.getElementById('authSignInPanel') || {}).hidden,
                nameHidden: (document.getElementById('authDisplayNamePanel') || {}).hidden,
                createHidden: (document.getElementById('authCreatePanel') || {}).hidden,
                pending: document.documentElement.classList.contains('auth-pending'),
                nameInput: (document.getElementById('authDisplayNameInput') || {}).value || '',
                createEmail: (document.getElementById('authCreateEmail') || {}).value || '',
                createPassword: (document.getElementById('authCreatePassword') || {}).value || '',
                createConfirm: (document.getElementById('authCreatePasswordConfirm') || {}).value || '',
                createName: (document.getElementById('authCreateDisplayName') || {}).value || ''
            }));
            ok('name-gate sign-out returns to sign-in', afterNameSignOut.signInHidden === false && afterNameSignOut.nameHidden === true && afterNameSignOut.createHidden === true && afterNameSignOut.pending, JSON.stringify(afterNameSignOut));
            ok(
                'name-gate sign-out clears name and create fields',
                afterNameSignOut.nameInput === ''
                    && afterNameSignOut.createEmail === ''
                    && afterNameSignOut.createPassword === ''
                    && afterNameSignOut.createConfirm === ''
                    && afterNameSignOut.createName === '',
                JSON.stringify(afterNameSignOut)
            );
            await page.evaluate(() => {
                applyAuthSnapshot({
                    configured: true,
                    signedIn: true,
                    displayName: '',
                    emailVerified: true,
                    provider: 'google.com'
                });
            });
            await page.waitForFunction(() => {
                const panel = document.getElementById('authDisplayNamePanel');
                return panel && !panel.hidden;
            });

            // Continue uses AppAuth.snapshot(); without a real Firebase user that
            // snapshot is signedOut and would re-lock. Drive the post-name unlock
            // the way boot does after a signed-in user with a claimed name.
            await page.evaluate(() => {
                const claimed = {
                    configured: true,
                    signedIn: true,
                    displayName: 'River',
                    email: '',
                    emailVerified: true,
                    provider: 'google.com',
                    providerLabel: 'Google'
                };
                AppAuth.getDisplayName = () => 'River';
                AppAuth.snapshot = () => claimed;
                applyAuthSnapshot(claimed);
            });
            await page.waitForFunction(() => {
                const gate = document.getElementById('authGate');
                return gate && getComputedStyle(gate).display === 'none';
            });
            const unlocked = await page.evaluate(() => ({
                pending: document.documentElement.classList.contains('auth-pending'),
                gate: getComputedStyle(document.getElementById('authGate')).display,
                chip: (document.getElementById('accountChipName') || {}).textContent,
                house: Array.from(document.querySelectorAll('.house-row .player-name')).map((el) => el.textContent)
            }));
            ok('name plus signed-in snapshot unlocks tracker', unlocked.pending === false && unlocked.gate === 'none', JSON.stringify(unlocked));
            ok('account chip shows saved name', unlocked.chip === 'River', unlocked.chip);
            ok('house rows present after auth unlock', unlocked.house.includes('Dealer') && unlocked.house.includes('Host'), JSON.stringify(unlocked.house));
            await shot(page, 'tracker-after-display-name.png');

            await tap(page, '#roomBtn');
            await page.waitForSelector('#roomModal', { visible: true });
            const room = await page.evaluate(() => {
                const modal = document.getElementById('roomModal');
                const el = document.getElementById('roomDisplayName');
                const notConfigured = document.getElementById('roomNotConfigured');
                const solo = document.getElementById('roomSoloPanel');
                const rakeYes = document.querySelector('#roomRakeGroup input[name="roomRakeEnabled"][value="yes"]');
                return {
                    display: modal ? modal.style.display : 'missing',
                    value: el ? (el.tagName === 'INPUT' ? el.value : el.textContent) : '',
                    tag: el ? el.tagName : '',
                    configuredBannerHidden: notConfigured ? notConfigured.hidden : null,
                    soloHidden: solo ? solo.hidden : null,
                    rakeToggle: !!rakeYes
                };
            });
            ok('room modal opens after sign-in name', room.display === 'block', room.display);
            ok('room create/join shown when Firebase configured', room.configuredBannerHidden === true && room.soloHidden === false, JSON.stringify(room));
            ok('room modal shows display name after auth', room.value === 'River', room.value);
            ok('room display name is not editable', room.tag !== 'INPUT', room.tag);
            ok('room rake toggle present on create', room.rakeToggle);
            const joinField = await page.evaluate(() => {
                const el = document.getElementById('joinRoomCode');
                return {
                    placeholder: el ? el.placeholder : '',
                    maxLength: el ? el.maxLength : null
                };
            });
            ok(
                'join code field is 4-digit',
                joinField.placeholder === '1234' && joinField.maxLength === 5,
                JSON.stringify(joinField)
            );
            const capHint = await page.evaluate(() => {
                const hints = Array.from(document.querySelectorAll('#roomSoloPanel .room-field-hint')).map((el) => el.textContent);
                return hints.join(' ');
            });
            ok('room create mentions 3-room cap and 1-week lifetime', /3 rooms/i.test(capHint) && /1 week/i.test(capHint), capHint);

            await page.click('#roomRakeGroup input[name="roomRakeEnabled"][value="yes"]');
            await page.waitForFunction(() => {
                const details = document.getElementById('roomRakeDetails');
                return details && !details.hidden;
            });
            await page.select('#roomRakeType', 'pot');
            await page.waitForFunction(() => {
                const pot = document.querySelector('#roomRakeGroup [data-rake-fields="pot"]');
                return pot && !pot.hidden;
            });
            const rakeUi = await page.evaluate(() => {
                const types = Array.from(document.querySelectorAll('#roomRakeType option')).map((o) => o.value);
                const potVisible = !document.querySelector('#roomRakeGroup [data-rake-fields="pot"]').hidden;
                return { types, potVisible };
            });
            ok('room create rake structures', ['time', 'pot', 'flat', 'custom'].every((t) => rakeUi.types.includes(t)), JSON.stringify(rakeUi.types));
            ok('room create pot-percent fields shown', rakeUi.potVisible);
            await shot(page, 'room-create-rake.png');

            await page.evaluate(() => {
                const modal = document.getElementById('roomModal');
                if (modal) modal.style.display = 'none';
                window.__roomRenames = [];
                AppAuth.setDisplayName = async (name) => {
                    const trimmed = String(name || '').trim();
                    if (!trimmed) throw new Error('Enter a display name');
                    return trimmed;
                };
                RoomSync.updateMyDisplayName = async (name) => {
                    window.__roomRenames.push(name);
                    return { displayName: name };
                };
            });
            await tap(page, '#accountBtn');
            await page.waitForSelector('#accountModal', { visible: true });
            const settingsNameUi = await page.evaluate(() => {
                const el = document.getElementById('roomDisplayName');
                return { tag: el ? el.tagName : '', value: el ? el.textContent : '' };
            });
            ok('room create/join name stays read-only in settings', settingsNameUi.tag !== 'INPUT', JSON.stringify(settingsNameUi));
            await page.$eval('#accountDisplayName', (el) => { el.value = 'Robert'; });
            await tap(page, '#accountForm button[type="submit"]');
            await page.waitForFunction(() => {
                const modal = document.getElementById('accountModal');
                return modal && modal.style.display === 'none';
            });
            const settingsRenames = await page.evaluate(() => window.__roomRenames.slice());
            ok('settings save updates live room display name', settingsRenames.length === 1 && settingsRenames[0] === 'Robert', JSON.stringify(settingsRenames));

            await page.evaluate(() => { window.__roomRenames = []; });
            await page.evaluate(() => {
                applyAuthSnapshot({
                    configured: true,
                    signedIn: true,
                    displayName: '',
                    emailVerified: true,
                    provider: 'google.com'
                });
            });
            await page.waitForFunction(() => {
                const panel = document.getElementById('authDisplayNamePanel');
                return panel && !panel.hidden;
            });
            await page.$eval('#authDisplayNameInput', (el) => { el.value = 'Charlie'; });
            await tap(page, '#authDisplayNameForm button[type="submit"]');
            await page.waitForFunction(() => Array.isArray(window.__roomRenames) && window.__roomRenames.length > 0);
            const gateRenames = await page.evaluate(() => window.__roomRenames.slice());
            ok('sign-in name gate updates live room display name', gateRenames.length === 1 && gateRenames[0] === 'Charlie', JSON.stringify(gateRenames));
            const stillReadonly = await page.$eval('#roomDisplayName', (el) => el.tagName);
            ok('room create/join name is still not an input', stillReadonly !== 'INPUT', stillReadonly);
        });

        await scenario('solo tracker buy-in house rake', async (page) => {
            await interceptEmptyFirebase(page);
            await gotoApp(page, origin);
            await page.evaluate(() => localStorage.clear());
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#accountBtn', { visible: true });

            const solo = await page.evaluate(() => ({
                pending: document.documentElement.classList.contains('auth-pending'),
                gateDisplay: getComputedStyle(document.getElementById('authGate')).display,
                account: document.getElementById('accountBtn')?.hidden === false,
                players: document.getElementById('totalPlayers')?.textContent,
                house: Array.from(document.querySelectorAll('.house-row .player-name')).map((el) => el.textContent),
                houseBuyIn: Array.from(document.querySelectorAll('.house-row td:nth-child(2)')).map((el) => el.textContent),
                rake: document.getElementById('rakeDisplay')?.textContent,
                notes: Array.from(document.querySelectorAll('.house-row .house-note')).map((el) => el.textContent)
            }));
            ok('solo skips auth gate', solo.pending === false && solo.gateDisplay === 'none', JSON.stringify(solo));
            ok('account chip visible in solo', solo.account);
            ok('player count excludes house rows', solo.players === '0', solo.players);
            ok('dealer and host rows pinned at $0', solo.house.includes('Dealer') && solo.house.includes('Host') && solo.houseBuyIn.every((t) => t === '$0.00'), JSON.stringify(solo));
            ok('default rake is no rake', solo.rake === 'No rake', solo.rake);
            ok('house rows have no plus/minus stack controls', solo.notes.includes('tip only') && solo.notes.includes('pay only'), JSON.stringify(solo.notes));
            await shot(page, 'solo-house-rows.png');

            await addPlayer(page, 'Alice', 200);
            const before = await page.$eval('.buyin-amount', (el) => el.textContent);
            ok('buy-in shows $200.00', before === '$200.00', before);
            const countAfterAdd = await page.$eval('#totalPlayers', (el) => el.textContent);
            ok('player count is 1 after add, house excluded', countAfterAdd === '1', countAfterAdd);

            await tap(page, '.buyin-amount');
            await page.waitForSelector('.buyin-input');
            await page.$eval('.buyin-input', (el) => {
                el.value = '350.5';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.$eval('.buyin-input', (el) => el.blur());
            await page.waitForFunction(() => {
                const el = document.querySelector('.buyin-amount');
                return el && el.textContent === '$350.50';
            });
            const after = await page.$eval('.buyin-amount', (el) => el.textContent);
            ok('typed buy-in saved', after === '$350.50', after);

            const undoOn = await page.$eval('#undoBtn', (el) => !el.disabled);
            ok('undo enabled after typed buy-in', undoOn);
            await page.waitForFunction(() => {
                const el = document.getElementById('undoBtn');
                return el && !el.disabled && Number(getComputedStyle(el).opacity) > 0.9;
            });
            const tapTargets = await page.evaluate(() => {
                function look(id) {
                    const el = document.getElementById(id);
                    if (!el) return { id, missing: true };
                    const s = getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return {
                        id,
                        disabled: el.disabled,
                        opacity: Number(s.opacity),
                        bg: s.backgroundColor,
                        w: Math.round(r.width),
                        h: Math.round(r.height),
                        hit: top === el || el.contains(top)
                    };
                }
                return { undo: look('undoBtn'), copy: look('copyResultsBtn') };
            });
            ok(
                'enabled undo is opaque and hittable',
                tapTargets.undo.disabled === false
                    && tapTargets.undo.opacity > 0.9
                    && tapTargets.undo.hit
                    && tapTargets.undo.h >= 36
                    && tapTargets.undo.bg !== 'rgba(0, 0, 0, 0)',
                JSON.stringify(tapTargets.undo)
            );
            ok(
                'copy button is enabled, opaque, and hittable',
                tapTargets.copy.disabled === false
                    && tapTargets.copy.opacity > 0.9
                    && tapTargets.copy.hit
                    && tapTargets.copy.h >= 36
                    && tapTargets.copy.bg !== 'rgba(0, 0, 0, 0)',
                JSON.stringify(tapTargets.copy)
            );
            await tap(page, '#undoBtn');
            await page.waitForFunction(() => {
                const el = document.querySelector('.buyin-amount');
                return el && el.textContent === '$200.00';
            });
            ok('undo restores typed buy-in', true);

            await tap(page, '.buyin-amount');
            await page.waitForSelector('.buyin-input');
            await page.$eval('.buyin-input', (el) => {
                el.value = '-40';
            });
            await page.$eval('.buyin-input', (el) => el.blur());
            await page.waitForSelector('.buyin-amount');
            const rejected = await page.$eval('.buyin-amount', (el) => el.textContent);
            ok('negative typed buy-in rejected to $0.00', rejected === '$0.00', rejected);
            await tap(page, '#undoBtn');
            await page.waitForFunction(() => {
                const el = document.querySelector('.buyin-amount');
                return el && el.textContent === '$200.00';
            });

            await tap(page, '.buyin-amount');
            await page.waitForSelector('.buyin-input');
            await page.$eval('.buyin-input', (el) => { el.value = '999'; });
            await page.focus('.buyin-input');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.buyin-amount');
            const escaped = await page.$eval('.buyin-amount', (el) => el.textContent);
            ok('escape cancels typed buy-in', escaped === '$200.00', escaped);
            await shot(page, 'typed-buyin.png');

            const houseCount = await page.$$eval('.house-row .cashout-input', (els) => els.length);
            ok('two house cash-out fields', houseCount === 2, String(houseCount));
            await page.evaluate(() => {
                const el = document.querySelectorAll('.house-row .cashout-input')[0];
                el.value = '15';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.waitForFunction(() => {
                const el = document.querySelector('.house-row .cashout-input');
                return el && (el.value === '15' || el.value === '15.00');
            });
            await page.evaluate(() => {
                const el = document.querySelectorAll('.house-row .cashout-input')[1];
                el.value = '-8';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            const houseCash = await page.evaluate(() => {
                const vals = Array.from(document.querySelectorAll('.house-row .cashout-input')).map((el) => el.value);
                const breakdown = Array.from(document.querySelectorAll('.balance-stat')).map((el) => el.textContent.trim());
                const total = document.getElementById('totalBalance')?.textContent;
                return { vals, breakdown, total };
            });
            ok('house cash never goes negative', houseCash.vals[1] === '0' || houseCash.vals[1] === '0.00', JSON.stringify(houseCash.vals));
            ok('house cash counted in total', /Dealer \+ Host\$15/.test(houseCash.breakdown.join('').replace(/\s+/g, '')) || houseCash.breakdown.some((t) => /Dealer \+ Host/.test(t) && /\$15/.test(t)), JSON.stringify(houseCash.breakdown));
            await shot(page, 'house-cash-balance.png');

            await tap(page, '#rakeDisplay');
            await page.waitForSelector('#rakeModal', { visible: true });
            await tap(page, '#rakeModal input[name="rakeEnabled"][value="yes"]');
            await page.waitForFunction(() => {
                const details = document.getElementById('rakeStructureFields');
                return details && !details.hidden;
            });
            const structures = await page.evaluate(() => Array.from(document.querySelectorAll('#rakeType option')).map((o) => o.value));
            ok('solo rake structures', ['time', 'pot', 'flat', 'custom'].every((t) => structures.includes(t)), JSON.stringify(structures));
            await page.select('#rakeType', 'flat');
            await page.$eval('#rakePerPlayer', (el) => { el.value = '10'; });
            await tap(page, '#rakeForm button[type="submit"]');
            await page.waitForFunction(() => {
                const modal = document.getElementById('rakeModal');
                return !modal || modal.style.display === 'none';
            });
            const rakeLabel = await page.$eval('#rakeDisplay', (el) => el.textContent);
            ok('solo rake chip shows posted flat rule', /Flat \$10\.00\/player/.test(rakeLabel), rakeLabel);
            const hint = await page.evaluate(() => {
                const el = document.getElementById('rakeHint');
                return { hidden: el.hidden, text: el.textContent };
            });
            ok('rake hint is posted rule not a pot calculator', /Enter the real amount on Host \/ Dealer/.test(hint.text) && !hint.hidden, JSON.stringify(hint));
            await shot(page, 'solo-rake-flat.png');

            await tap(page, '#sessionClockBtn');
            await page.waitForFunction(() => document.getElementById('sessionClockBtn')?.textContent === 'Pause');
            await page.waitForFunction(() => document.getElementById('sessionClockTime')?.textContent !== '00:00:00', { timeout: 2500 });
            const clock = await page.$eval('#sessionClockTime', (el) => el.textContent);
            ok('session clock starts', clock !== '00:00:00', clock);
            const resetWhileRunning = await page.$eval('#sessionClockResetBtn', (el) => ({
                text: el.textContent.trim(),
                disabled: el.disabled
            }));
            ok('reset is available while the clock is running', resetWhileRunning.text === 'Reset' && !resetWhileRunning.disabled, JSON.stringify(resetWhileRunning));

            await tap(page, '#sessionClockBtn');
            await page.waitForFunction(() => document.getElementById('sessionClockBtn')?.textContent === 'Resume');
            const paused = await page.evaluate(() => ({
                btn: document.getElementById('sessionClockBtn')?.textContent,
                time: document.getElementById('sessionClockTime')?.textContent
            }));
            ok('pause turns the button into Resume', paused.btn === 'Resume' && paused.time !== '00:00:00', JSON.stringify(paused));
            const pausedTime = paused.time;
            await new Promise((resolve) => setTimeout(resolve, 1200));
            const stillPaused = await page.$eval('#sessionClockTime', (el) => el.textContent);
            ok('paused clock does not keep ticking', stillPaused === pausedTime, `${pausedTime} -> ${stillPaused}`);

            await tap(page, '#sessionClockBtn');
            await page.waitForFunction(() => document.getElementById('sessionClockBtn')?.textContent === 'Pause');
            ok('resume turns the button back into Pause', true);

            await tap(page, '#sessionClockResetBtn');
            await page.waitForFunction(() => {
                const time = document.getElementById('sessionClockTime')?.textContent;
                const btn = document.getElementById('sessionClockBtn')?.textContent;
                const reset = document.getElementById('sessionClockResetBtn');
                return time === '00:00:00' && btn === 'Start' && reset && reset.disabled;
            });
            const resetState = await page.evaluate(() => ({
                time: document.getElementById('sessionClockTime')?.textContent,
                btn: document.getElementById('sessionClockBtn')?.textContent,
                resetDisabled: document.getElementById('sessionClockResetBtn')?.disabled
            }));
            ok('reset returns the clock to 00:00:00 and Start', resetState.time === '00:00:00' && resetState.btn === 'Start' && resetState.resetDisabled, JSON.stringify(resetState));
            await shot(page, 'session-clock-reset.png');

            const headerClock = await page.evaluate(() => {
                const btn = document.getElementById('actionClockBtn');
                const theme = document.getElementById('themeToggle');
                const br = btn ? btn.getBoundingClientRect() : null;
                const tr = theme ? theme.getBoundingClientRect() : null;
                return {
                    present: !!btn,
                    title: btn ? btn.getAttribute('title') : '',
                    inHeader: !!(btn && btn.closest('.header-buttons')),
                    width: br ? Math.round(br.width) : 0,
                    themeWidth: tr ? Math.round(tr.width) : 0
                };
            });
            ok('action clock button sits in the header cluster', headerClock.present && headerClock.inHeader && /clock/i.test(headerClock.title), JSON.stringify(headerClock));
            ok(
                'action clock button matches other header button size',
                headerClock.width > 0 && Math.abs(headerClock.width - headerClock.themeWidth) <= 2,
                JSON.stringify(headerClock)
            );
            await tap(page, '#actionClockBtn');
            await page.waitForFunction(() => {
                const overlay = document.getElementById('actionClockOverlay');
                return overlay && !overlay.hidden;
            });
            const clockSetup = await page.evaluate(() => {
                const overlay = document.getElementById('actionClockOverlay');
                const selected = document.querySelector('.action-clock-preset.is-selected');
                return {
                    visible: overlay && !overlay.hidden,
                    time: (document.getElementById('actionClockTime') || {}).textContent || '',
                    selected: selected ? selected.getAttribute('data-seconds') : '',
                    start: (document.getElementById('actionClockStart') || {}).textContent || '',
                    fullscreen: overlay ? getComputedStyle(overlay).position === 'fixed' : false
                };
            });
            ok(
                'action clock opens full screen at 60s by default',
                clockSetup.visible && clockSetup.fullscreen && clockSetup.time === '1:00'
                    && clockSetup.selected === '60' && /start/i.test(clockSetup.start),
                JSON.stringify(clockSetup)
            );
            await shot(page, 'action-clock-setup.png');
            await tap(page, '.action-clock-preset[data-seconds="30"]');
            await page.waitForFunction(() => (document.getElementById('actionClockTime') || {}).textContent === '0:30');
            await tap(page, '#actionClockStart');
            await page.waitForFunction(() => {
                const pause = document.getElementById('actionClockPause');
                const start = document.getElementById('actionClockStart');
                return pause && !pause.hidden && start && start.hidden;
            });
            await new Promise((resolve) => setTimeout(resolve, 1300));
            const running = await page.evaluate(() => ({
                time: (document.getElementById('actionClockTime') || {}).textContent || '',
                pause: (document.getElementById('actionClockPause') || {}).textContent || ''
            }));
            ok(
                'action clock counts down after start',
                /^0:2[789]$/.test(running.time) && /pause/i.test(running.pause),
                JSON.stringify(running)
            );
            await tap(page, '#actionClockPause');
            await page.waitForFunction(() => (document.getElementById('actionClockPause') || {}).textContent === 'Resume');
            const pausedAction = await page.$eval('#actionClockTime', (el) => el.textContent);
            await new Promise((resolve) => setTimeout(resolve, 800));
            const stillPausedAction = await page.$eval('#actionClockTime', (el) => el.textContent);
            ok('paused action clock does not keep ticking', stillPausedAction === pausedAction, `${pausedAction} -> ${stillPausedAction}`);
            await tap(page, '#actionClockClose');
            await page.waitForFunction(() => {
                const overlay = document.getElementById('actionClockOverlay');
                return overlay && overlay.hidden;
            });
            await tap(page, '#actionClockBtn');
            await page.waitForFunction(() => {
                const overlay = document.getElementById('actionClockOverlay');
                return overlay && !overlay.hidden;
            });
            const remembered = await page.evaluate(() => {
                const selected = document.querySelector('.action-clock-preset.is-selected');
                return {
                    time: (document.getElementById('actionClockTime') || {}).textContent || '',
                    selected: selected ? selected.getAttribute('data-seconds') : ''
                };
            });
            ok('action clock remembers the last duration', remembered.selected === '30' && remembered.time === '0:30', JSON.stringify(remembered));
            await tap(page, '#actionClockCustomPreset');
            await page.waitForFunction(() => {
                const row = document.getElementById('actionClockCustomRow');
                return row && !row.hidden;
            });
            await page.$eval('#actionClockCustomInput', (el) => { el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
            await page.waitForFunction(() => (document.getElementById('actionClockTime') || {}).textContent === '0:15');
            const custom = await page.evaluate(() => ({
                time: (document.getElementById('actionClockTime') || {}).textContent || '',
                selected: (document.querySelector('.action-clock-preset.is-selected') || {}).getAttribute
                    ? document.querySelector('.action-clock-preset.is-selected').getAttribute('data-seconds')
                    : ''
            }));
            ok('custom action clock duration is accepted', custom.time === '0:15' && custom.selected === 'custom', JSON.stringify(custom));
            await shot(page, 'action-clock-custom.png');
            await tap(page, '#actionClockClose');
            await page.waitForFunction(() => {
                const overlay = document.getElementById('actionClockOverlay');
                return overlay && overlay.hidden;
            });

            await tap(page, '#blindDisplay');
            await page.waitForSelector('#blindModal', { visible: true });
            await tap(page, '.preset-btn[data-small="2"][data-big="5"]');
            await page.waitForFunction(() => document.getElementById('stackAmount')?.value === '500');
            await tap(page, '#blindForm button[type="submit"]');
            const stack = await page.$eval('#stackAmount', (el) => el.value);
            const blinds = await page.$eval('#blindDisplay', (el) => el.textContent);
            ok('blind/stack preset applied', stack === '500' && /2/.test(blinds) && /5/.test(blinds), `${stack} ${blinds}`);

            await page.evaluate(() => {
                const el = document.querySelector('tr:not(.house-row) .cashout-input');
                el.value = '170';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.waitForFunction(() => {
                const section = document.getElementById('settlementSection');
                return section && !section.hidden;
            });
            const settlement = await page.evaluate(() => {
                const section = document.getElementById('settlementSection');
                const items = Array.from(document.querySelectorAll('#settlementList li')).map((el) => el.textContent.trim());
                return { hidden: section.hidden, items };
            });
            ok('settlement helper lists transfers', settlement.hidden === false && settlement.items.length > 0, JSON.stringify(settlement));
            await shot(page, 'settlement-helper.png');

            const paidCol = await page.evaluate(() => {
                const th = document.querySelector('#playerTable thead th.settle-col');
                const playerBtn = document.querySelector('tr:not(.house-row) .settle-toggle');
                const houseBtns = document.querySelectorAll('.house-row .settle-toggle');
                return {
                    header: th ? th.textContent.trim() : '',
                    player: !!(playerBtn && playerBtn.getAttribute('aria-pressed') === 'false'),
                    house: houseBtns.length
                };
            });
            ok('paid column is on the table', /paid/i.test(paidCol.header) && paidCol.player && paidCol.house === 2, JSON.stringify(paidCol));
            await tap(page, 'tr:not(.house-row) .settle-toggle');
            await page.waitForFunction(() => {
                const btn = document.querySelector('tr:not(.house-row) .settle-toggle');
                return btn && btn.getAttribute('aria-pressed') === 'true';
            });
            ok('paid toggle marks the player settled', true);

            await page.browserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write']);
            await tap(page, '#copyResultsBtn');
            await page.waitForFunction(() => document.getElementById('copyResultsBtn')?.textContent === 'Copied');
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            ok(
                'copy results includes names and settlement',
                /Alice/.test(copied) && /Settlement/i.test(copied) && /Dealer/.test(copied),
                copied.slice(0, 400)
            );

            await addPlayer(page, 'Bob', 200);
            await page.evaluate(() => {
                const inputs = document.querySelectorAll('tr:not(.house-row) .cashout-input');
                inputs[0].value = '280';
                inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
                inputs[1].value = '150';
                inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.waitForFunction(() => {
                const btn = document.getElementById('chopLeftoverBtn');
                return btn && !btn.hidden && /chop/i.test(btn.textContent || '');
            });
            const chopLabel = await page.$eval('#chopLeftoverBtn', (el) => el.textContent);
            ok('chop leftover is offered when books do not balance', /chop/i.test(chopLabel) && /winner/i.test(chopLabel), chopLabel);
            await shot(page, 'settlement-chop-offer.png');
            await page.evaluate(() => { window.confirm = () => true; });
            await tap(page, '#chopLeftoverBtn');
            await page.waitForFunction(() => {
                const total = document.getElementById('totalBalance')?.textContent || '';
                const btn = document.getElementById('chopLeftoverBtn');
                return /\$0\.00/.test(total) && btn && btn.hidden;
            });
            const afterChop = await page.evaluate(() => ({
                total: document.getElementById('totalBalance')?.textContent,
                chopHidden: document.getElementById('chopLeftoverBtn')?.hidden,
                aliceOut: document.querySelector('tr:not(.house-row) .cashout-input')?.value
            }));
            ok('chop leftover closes the books', afterChop.total === '$0.00' && afterChop.chopHidden === true, JSON.stringify(afterChop));
            await shot(page, 'settlement-paid-copy-chop.png');

            await tap(page, '#accountBtn');
            await page.waitForSelector('#accountModal', { visible: true });
            const accountUi = await page.evaluate(() => {
                const btn = document.getElementById('signOutBtn');
                const line = document.getElementById('accountProviderLine');
                return {
                    signOutHidden: btn ? btn.hidden : null,
                    line: line ? line.textContent : ''
                };
            });
            ok('solo account has no sign-out', accountUi.signOutHidden === true, JSON.stringify(accountUi));
            ok('solo account is on-device name', /this device/i.test(accountUi.line), accountUi.line);
            await page.$eval('#accountDisplayName', (el) => { el.value = 'River'; });
            await tap(page, '#accountForm button[type="submit"]');
            await page.waitForFunction(() => {
                const modal = document.getElementById('accountModal');
                return modal && modal.style.display === 'none';
            });
            const chip = await page.$eval('#accountChipName', (el) => el.textContent);
            ok('default display name saved', chip === 'River', chip);

            const roomState = await page.evaluate(() => {
                window.openRoomModal();
                const modal = document.getElementById('roomModal');
                const el = document.getElementById('roomDisplayName');
                const notConfigured = document.getElementById('roomNotConfigured');
                return {
                    display: modal ? modal.style.display : 'missing',
                    value: el ? (el.tagName === 'INPUT' ? el.value : el.textContent) : '',
                    tag: el ? el.tagName : '',
                    banner: notConfigured ? { hidden: notConfigured.hidden, text: notConfigured.textContent } : null
                };
            });
            ok('room modal opens', roomState.display === 'block', roomState.display);
            ok('room modal shows display name', roomState.value === 'River', roomState.value);
            ok('room display name is not an input', roomState.tag !== 'INPUT', roomState.tag);
            const peopleHint = await page.$eval('#peopleModal .room-hint', (el) => el.textContent);
            ok('people modal labels Room host as a permission', /Room host is a permission, not the Host payee/i.test(peopleHint), peopleHint);
            await shot(page, 'solo-account-room-name.png');
        });

        await scenario('legacy localStorage defaults', async (page) => {
            await interceptEmptyFirebase(page);
            await gotoApp(page, origin);
            await page.evaluate(() => {
                localStorage.clear();
                localStorage.setItem('pokerStackTracker', JSON.stringify({
                    blindStructure: { small: 1, big: 2 },
                    stackAmount: 200,
                    players: [{ id: 1, name: 'OldAlice', totalBuyIn: 100, cashOut: 0 }],
                    darkMode: true,
                    sessionName: 'Legacy night'
                }));
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#playerTableBody');
            await page.waitForFunction(() => document.querySelectorAll('.house-row').length === 2);
            const legacy = await page.evaluate(() => ({
                names: Array.from(document.querySelectorAll('#playerTableBody .player-name')).map((el) => el.textContent),
                players: document.getElementById('totalPlayers')?.textContent,
                rake: document.getElementById('rakeDisplay')?.textContent,
                session: document.getElementById('sessionName')?.textContent,
                houseCash: Array.from(document.querySelectorAll('.house-row .cashout-input')).map((el) => el.value)
            }));
            ok('legacy localStorage keeps player', legacy.names.includes('OldAlice'), JSON.stringify(legacy.names));
            ok('legacy localStorage adds house rows at 0', legacy.names.includes('Dealer') && legacy.names.includes('Host') && legacy.houseCash.every((v) => v === '0' || v === '0.00'), JSON.stringify(legacy));
            ok('legacy localStorage defaults rake', legacy.rake === 'No rake', legacy.rake);
            ok('legacy player count excludes house', legacy.players === '1', legacy.players);
            ok('legacy session name kept', legacy.session === 'Legacy night', legacy.session);
            await shot(page, 'legacy-localstorage.png');
        });

        await scenario('solo tracker mobile', async (page) => {
            await interceptEmptyFirebase(page);
            await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
            await gotoApp(page, origin);
            await page.evaluate(() => localStorage.clear());
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#addPlayerBtn', { visible: true });
            await addPlayer(page, 'Alice', 200);
            await shot(page, 'solo-tracker-mobile.png');
            const mobile = await page.evaluate(() => ({
                house: document.querySelectorAll('.house-row').length,
                buyIn: document.querySelector('.buyin-amount')?.textContent,
                rake: document.getElementById('rakeDisplay')?.textContent
            }));
            ok('mobile tracker shows house rows and typed buy-in control', mobile.house === 2 && mobile.buyIn === '$200.00', JSON.stringify(mobile));
        });
    } finally {
        await browser.close();
        server.close();
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
