'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const XLSX  = require('xlsx');
const { v4: uuidv4 } = require('uuid');

// Tell playwright where bundled browsers live inside the EXE
function setupPlaywrightBrowsers() {
  const bundled = path.join(process.resourcesPath, 'browsers');
  if (fs.existsSync(bundled)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
  }
}
setupPlaywrightBrowsers();

const { chromium } = require('playwright');

// ─── Window ───────────────────────────────────────────────────────────────────
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1300,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#080b12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ─── Window controls ──────────────────────────────────────────────────────────
ipcMain.handle('win-min',   () => win.minimize());
ipcMain.handle('win-max',   () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.handle('win-close', () => win.close());

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.filePaths[0] || null;
});

ipcMain.handle('reveal-file', (_, p) => shell.showItemInFolder(p));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function emit(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}
function log(type, msg) { emit('log', { type, msg }); }

// ─── Stop flag ────────────────────────────────────────────────────────────────
let stopFlag = false;
ipcMain.on('stop', () => { stopFlag = true; });

// ─── Done scrolling (fired by user clicking the button) ───────────────────────
// Stored as a resolve callback so the scrape loop can await it
let doneScrollingResolve = null;
ipcMain.on('done-scrolling', () => {
  if (doneScrollingResolve) {
    doneScrollingResolve();
    doneScrollingResolve = null;
  }
});

// ─── START SCRAPE — use ipcMain.on (fire-and-forget, NOT invoke) ──────────────
// This is the key fix: we use ipcMain.on instead of ipcMain.handle so the
// renderer is NOT blocked waiting for a return value, and can receive events.
ipcMain.on('scrape', (_, { keyword, total, folder }) => {
  runScrape(keyword, total, folder);
});

async function runScrape(keyword, total, folder) {
  stopFlag = false;

  try {
    log('info', 'Launching browser...');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });

    const page = await context.newPage();
    const formattedQuery = keyword.replace(/ /g, '+');
    const searchUrl = `https://www.google.com/maps/search/${formattedQuery}?hl=en`;
    log('info', `Opening: ${searchUrl}`);

    await page.goto(searchUrl, { timeout: 60000 });
    await page.waitForSelector('xpath=//div[@role="feed"]');

    // Signal UI to show "Done Scrolling" button
    emit('state', 'waiting');
    log('warn', 'Scroll in Chrome to load all listings, then click DONE SCROLLING.');

    // Wait for user to click Done Scrolling
    await new Promise(resolve => { doneScrollingResolve = resolve; });

    emit('state', 'scraping');
    log('info', 'Collecting listing links...');

    const listings = await page.locator('xpath=//a[contains(@href,"/maps/place")]').all();
    const limit = Math.min(total, listings.length);
    emit('total', limit);
    log('info', `Found ${listings.length} listings. Scraping ${limit}...`);

    const results = [];

    for (let i = 0; i < limit; i++) {
      if (stopFlag) { log('warn', 'Stopped by user.'); break; }

      try {
        log('info', `Processing ${i + 1} of ${limit}...`);
        await listings[i].click();
        await page.waitForSelector('xpath=//h1[contains(@class,"DUwDvf")]', { timeout: 15000 });
        await page.waitForTimeout(2000);

        const place = await extractPlace(page, context);

        if (place.name) {
          results.push(place);
          emit('row', place);                                    // send row to UI immediately
          emit('progress', { current: i + 1, total: limit });
          log('success', `✓ ${place.name}`);
        }

        await page.goBack();
        await page.waitForSelector('xpath=//div[@role="feed"]');

      } catch (e) {
        log('error', `Listing ${i + 1} failed: ${e.message}`);
      }
    }

    await browser.close();

    // Save Excel
    if (results.length > 0) {
      const outDir = folder || app.getPath('documents');
      fs.mkdirSync(outDir, { recursive: true });
      const filename  = `scraped_${uuidv4().slice(0, 8)}.xlsx`;
      const filePath  = path.join(outDir, filename);
      const worksheet = XLSX.utils.json_to_sheet(results);
      const workbook  = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Results');
      XLSX.writeFile(workbook, filePath);
      log('success', `Saved ${results.length} records → ${filePath}`);
      emit('done', { count: results.length, file: filePath });
    } else {
      log('warn', 'No data collected.');
      emit('done', { count: 0, file: null });
    }

  } catch (e) {
    log('error', `Fatal: ${e.message}`);
    emit('done', { count: 0, file: null });
  }
}

// ─── Scraper helpers (identical to original script) ───────────────────────────
async function extractText(page, xpath) {
  try {
    const locator = page.locator(`xpath=${xpath}`);
    if (await locator.count() > 0) return (await locator.first().innerText()).trim();
  } catch {}
  return '';
}

async function extractEmailFromWebsite(context, websiteUrl) {
  if (!websiteUrl) return [];
  if (!websiteUrl.startsWith('http')) websiteUrl = 'https://' + websiteUrl;

  let mainTab;
  let emails = [];

  try {
    mainTab = await context.newPage();
    await mainTab.goto(websiteUrl, { timeout: 20000 });
    await mainTab.waitForLoadState('load', { timeout: 15000 });

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+/g;

    const html = await mainTab.content();
    emails.push(...(html.match(emailRegex) || []));

    const mailtos = await mainTab.$$eval("a[href^='mailto:']",
      links => links.map(l => l.getAttribute('href').replace('mailto:', '').trim())
    );
    emails.push(...mailtos);

    const importantKeywords = ['contact', 'about', 'team', 'support', 'info'];
    const anchors = await mainTab.$$eval('a[href]', a => a.map(l => l.href));
    const filteredLinks = anchors
      .filter(l => importantKeywords.some(kw => l.toLowerCase().includes(kw)))
      .slice(0, 5);

    const emailPromises = filteredLinks.map(async link => {
      let tab;
      try {
        tab = await context.newPage();
        await tab.goto(link, { timeout: 15000 });
        await tab.waitForLoadState('load', { timeout: 10000 });
        return (await tab.content()).match(emailRegex) || [];
      } catch { return []; }
      finally { if (tab) await tab.close(); }
    });

    const emailResults = await Promise.all(emailPromises);
    emailResults.forEach(arr => emails.push(...arr));

    emails = [...new Set(emails)].filter(e =>
      e &&
      !e.toLowerCase().match(/\.(png|jpg|jpeg|svg|gif)/) &&
      !e.toLowerCase().includes('example') &&
      !e.toLowerCase().includes('test')
    );

  } catch {}
  finally { if (mainTab) await mainTab.close(); }

  return emails;
}

async function extractPlace(page, context) {
  const name         = await extractText(page, '//h1[contains(@class,"DUwDvf")]');
  const address      = await extractText(page, '//button[@data-item-id="address"]//div[contains(@class,"fontBodyMedium")]');
  const website      = await extractText(page, '//a[@data-item-id="authority"]//div[contains(@class,"fontBodyMedium")]');
  const phone_number = await extractText(page, '//button[contains(@data-item-id,"phone")]//div[contains(@class,"fontBodyMedium")]');
  const place_type   = await extractText(page, '//button[contains(@class,"DkEaL")]');
  const opens_at     = await extractText(page, '//button[contains(@data-item-id,"oh")]//div[contains(@class,"fontBodyMedium")]');
  const introduction = await extractText(page, '//div[contains(@class,"WeS02d")]');
  const email        = website ? (await extractEmailFromWebsite(context, website)).join(', ') : '';

  return { name, address, website, email, phone_number, place_type, opens_at, introduction };
}
