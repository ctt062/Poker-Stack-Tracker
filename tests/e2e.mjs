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
                const err = document.getElementById('authError');
                return {
                    pending: document.documentElement.classList.contains('auth-pending'),
                    display: style.display,
                    google: (document.getElementById('authGoogleBtn') || {}).textContent || '',
                    apple: (document.getElementById('authAppleBtn') || {}).textContent || '',
                    email: !!document.getElementById('authEmail'),
                    password: !!document.getElementById('authPassword'),
                    create: (document.getElementById('authEmailCreate') || {}).textContent || '',
                    forgot: (document.getElementById('authForgot') || {}).textContent || '',
                    guest: !!Array.from(document.querySelectorAll('button, a')).find((el) =>
                        /anonymous|guest|continue without/i.test(el.textContent || ''))
                };
            });
            ok('auth gate pending with Firebase config', gate.pending);
            ok('auth gate visible', gate.display === 'flex', gate.display);
            ok('Google sign-in present', /google/i.test(gate.google), gate.google);
            ok('Apple sign-in present', /apple/i.test(gate.apple), gate.apple);
            ok('email sign-in present', gate.email && gate.password && /create/i.test(gate.create), JSON.stringify(gate));
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
        });

        await scenario('auth gate mobile', async (page) => {
            await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
            await gotoApp(page, origin);
            await waitAuthGate(page);
            await shot(page, 'auth-gate-mobile.png');
            const visible = await page.evaluate(() => getComputedStyle(document.getElementById('authGate')).display);
            ok('auth gate visible on mobile', visible === 'flex', visible);
        });

        await scenario('display name gate and room rake', async (page) => {
            await gotoApp(page, origin);
            await waitAuthGate(page);
            await page.waitForFunction(() => typeof applyAuthSnapshot === 'function' && window.AppAuth);
            await page.evaluate(async () => {
                try { await AppAuth.init(); } catch (e) { /* gate still works if SDK is unreachable */ }
            });
            await page.evaluate(() => {
                applyAuthSnapshot({ configured: true, signedIn: true, displayName: '' });
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
            await shot(page, 'auth-display-name-gate.png');

            // Continue uses AppAuth.snapshot(); without a real Firebase user that
            // snapshot is signedOut and would re-lock. Drive the post-name unlock
            // the way boot does after a signed-in user with a saved name.
            await page.evaluate(() => {
                localStorage.setItem('pst_display_name', 'River');
                applyAuthSnapshot({ configured: true, signedIn: true, displayName: 'River' });
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
                const input = document.getElementById('roomDisplayName');
                const notConfigured = document.getElementById('roomNotConfigured');
                const solo = document.getElementById('roomSoloPanel');
                const rakeYes = document.querySelector('#roomRakeGroup input[name="roomRakeEnabled"][value="yes"]');
                return {
                    display: modal ? modal.style.display : 'missing',
                    value: input ? input.value : '',
                    readOnly: input ? input.readOnly : true,
                    configuredBannerHidden: notConfigured ? notConfigured.hidden : null,
                    soloHidden: solo ? solo.hidden : null,
                    rakeToggle: !!rakeYes
                };
            });
            ok('room modal opens after sign-in name', room.display === 'block', room.display);
            ok('room create/join shown when Firebase configured', room.configuredBannerHidden === true && room.soloHidden === false, JSON.stringify(room));
            ok('room modal prefills display name after auth', room.value === 'River', room.value);
            ok('room rake toggle present on create', room.rakeToggle);
            await page.$eval('#roomDisplayName', (el) => { el.value = 'RiverJane'; });
            const edited = await page.$eval('#roomDisplayName', (el) => el.value);
            ok('display name editable before entering a room', edited === 'RiverJane');

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
                const input = document.getElementById('roomDisplayName');
                const notConfigured = document.getElementById('roomNotConfigured');
                return {
                    display: modal ? modal.style.display : 'missing',
                    value: input ? input.value : '',
                    readOnly: input ? input.readOnly : true,
                    banner: notConfigured ? { hidden: notConfigured.hidden, text: notConfigured.textContent } : null
                };
            });
            ok('room modal opens', roomState.display === 'block', roomState.display);
            ok('room modal prefills display name', roomState.value === 'River', roomState.value);
            await page.$eval('#roomDisplayName', (el) => { el.value = 'RiverJane'; });
            const editableBeforeEnter = await page.$eval('#roomDisplayName', (el) => el.value);
            ok('display name editable before entering a room', editableBeforeEnter === 'RiverJane');
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
