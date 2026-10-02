#!/usr/bin/env node
/**
 * Behavioral tests against the running app in headless Chrome.
 * Asserts observable UI, not source text.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

async function withPage(browser, fn) {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    try {
        await fn(page);
    } finally {
        await page.close();
    }
}

async function addPlayer(page, name, buyIn) {
    await page.click('#addPlayerBtn');
    await page.waitForSelector('#playerModal', { visible: true });
    await page.$eval('#playerName', (el, n) => { el.value = n; }, name);
    await page.$eval('#playerBuyIn', (el, n) => { el.value = String(n); }, buyIn);
    await page.click('#playerForm button[type="submit"]');
    await page.waitForFunction(() => {
        const modal = document.getElementById('playerModal');
        return !modal || modal.style.display === 'none';
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

    try {
        await withPage(browser, async (page) => {
            await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle0' });
            const gate = await page.evaluate(() => {
                const style = getComputedStyle(document.getElementById('authGate'));
                return {
                    pending: document.documentElement.classList.contains('auth-pending'),
                    display: style.display,
                    google: !!document.getElementById('authGoogleBtn'),
                    apple: !!document.getElementById('authAppleBtn'),
                    email: !!document.getElementById('authEmail'),
                    password: !!document.getElementById('authPassword'),
                    create: !!document.getElementById('authEmailCreate')
                };
            });
            ok('auth gate pending with Firebase config', gate.pending);
            ok('auth gate visible', gate.display === 'flex', gate.display);
            ok('Google sign-in present', gate.google);
            ok('Apple sign-in present', gate.apple);
            ok('email sign-in present', gate.email && gate.password && gate.create);
        });

        await withPage(browser, async (page) => {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (req.url().includes('firebase-config.js')) {
                    req.respond({
                        status: 200,
                        contentType: 'application/javascript',
                        body: 'window.FIREBASE_CONFIG = { apiKey: "", projectId: "", appId: "" };'
                    });
                    return;
                }
                req.continue();
            });
            await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle0' });
            await page.evaluate(() => localStorage.clear());
            await page.reload({ waitUntil: 'networkidle0' });

            const solo = await page.evaluate(() => ({
                pending: document.documentElement.classList.contains('auth-pending'),
                gateDisplay: getComputedStyle(document.getElementById('authGate')).display,
                account: document.getElementById('accountBtn')?.hidden === false
            }));
            ok('solo skips auth gate', solo.pending === false && solo.gateDisplay === 'none', JSON.stringify(solo));
            ok('account chip visible in solo', solo.account);

            await addPlayer(page, 'Alice', 200);
            const before = await page.$eval('.buyin-amount', (el) => el.textContent);
            ok('buy-in shows $200.00', before === '$200.00', before);

            await page.click('.buyin-amount');
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
            await page.click('#undoBtn');
            await page.waitForFunction(() => {
                const el = document.querySelector('.buyin-amount');
                return el && el.textContent === '$200.00';
            });
            ok('undo restores typed buy-in', true);

            await page.click('#accountBtn');
            await page.waitForSelector('#accountModal', { visible: true });
            await page.$eval('#accountDisplayName', (el) => { el.value = 'River'; });
            await page.click('#accountForm button[type="submit"]');
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
                return {
                    display: modal ? modal.style.display : 'missing',
                    value: input ? input.value : '',
                    readOnly: input ? input.readOnly : true
                };
            });
            ok('room modal opens', roomState.display === 'block', roomState.display);
            ok('room modal prefills display name', roomState.value === 'River', roomState.value);
            await page.$eval('#roomDisplayName', (el) => { el.value = 'RiverJane'; });
            const editableBeforeEnter = await page.$eval('#roomDisplayName', (el) => el.value);
            ok('display name editable before entering a room', editableBeforeEnter === 'RiverJane');
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
