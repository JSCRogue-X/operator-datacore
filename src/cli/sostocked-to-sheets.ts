#!/usr/bin/env tsx
// Logs into SoStocked, downloads the "1. PA" inventory export,
// filters to Spincare ASINs (~85 rows), and writes the result to
// the "Claude Test" tab in OOS Tracking.
// Run: npx tsx src/cli/sostocked-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SPREADSHEET_ID = '1QriRw0CXwEeKF_qsFajLeEnCKErx0t6vKFbKM59H9iM';
const TAB_NAME       = 'Claude Test';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const SPINCARE_ASINS = new Set([
  'B017K5D518','B09ZF9QXSF','B071W7CX1W','B079HXR4V4','B08XM6D7JW','B0D6GWJD45',
  'B07CWYD5PS','B0937M9GFQ','B08F5LHNFS','B0FXH31JS8','B07RZTPX5G','B00XSM1CM2',
  'B08F5KLMS3','B07FPW2T2P','B076YJ9T38','B076YK7836','B08XM3PV8Q','B0937JF77Y',
  'B09ZFBD8ZZ','B072PZYKC5','B079J12K5C','B00KDFNHMU','B00XSP8N12','B0F4KQVXYP',
  'B0FZCS6L7N','B076P8BDSS','B07CWVWNYR','B0FQ5YYSGS','B09SGLLVK9','B089D1X4TX',
  'B09SGL4S1X','B0D45H8G8F','B0D45H8XZS','B093C7WVBH','B07RYVSDF4','B0GSBFLS4D',
  'B0H69Q1K1N','B01AKAHF52',
]);

// Handles quoted fields and embedded commas
function parseCSV(text: string): string[][] {
  const results: string[][] = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const row: string[] = [];
    let col = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { col += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        row.push(col); col = '';
      } else {
        col += ch;
      }
    }
    row.push(col);
    results.push(row);
  }
  return results;
}

async function main() {
  const email    = process.env.SOSTOCKED_EMAIL;
  const password = process.env.SOSTOCKED_PASSWORD;
  if (!email || !password) throw new Error('SOSTOCKED_EMAIL and SOSTOCKED_PASSWORD must be set');

  console.log('SoStocked → OOS Tracking (Claude Test)');
  console.log('----------------------------------------');

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page    = await context.newPage();

  const screenshotPath = path.join(os.tmpdir(), 'sostocked-debug.png');

  try {
    // ── Step 1: Login ────────────────────────────────────────────────────────
    console.log('Logging in to SoStocked...');
    await page.goto('https://app.sostocked.com/login', { waitUntil: 'domcontentloaded' });
    console.log(`  Redirected to: ${page.url()}`);

    // Auth0 universal login renders the form via JS after the redirect — wait for
    // a visible (non-hidden) input to appear rather than relying on networkidle
    await page.waitForSelector('input:not([type="hidden"])', { timeout: 30000 });

    // Screenshot so we can see the login page state in the artifact
    await page.screenshot({ path: screenshotPath });

    // Fill email — try multiple selector patterns in order
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
      'input[type="text"]:first-of-type',
    ];
    let emailFilled = false;
    for (const sel of emailSelectors) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.fill(email);
        emailFilled = true;
        console.log(`  Email filled via: ${sel}`);
        break;
      }
    }
    if (!emailFilled) throw new Error('Could not locate email input — check screenshot artifact');

    // Fill password
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="password" i]',
    ];
    let passwordFilled = false;
    for (const sel of passwordSelectors) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.fill(password);
        passwordFilled = true;
        console.log(`  Password filled via: ${sel}`);
        break;
      }
    }
    if (!passwordFilled) throw new Error('Could not locate password input — check screenshot artifact');

    await page.click('button[type="submit"]');
    // Wait until the callback fully resolves and we land on the actual app
    await page.waitForURL(
      url => !url.href.includes('/login') && !url.href.includes('/callback'),
      { timeout: 30000 },
    );
    console.log(`  Logged in. URL: ${page.url()}`);

    // ── Step 2: Navigate directly to the 1.PA inventory view ─────────────────
    // Navigate with page_view_id in the URL to avoid needing to click the tab
    // (the tab is inside a collapsed dropdown so it is never visible to click)
    console.log('Navigating to 1.PA inventory view...');
    await page.goto('https://app.sostocked.com/me/inventory?page_view_id=433959', { waitUntil: 'domcontentloaded' });
    // Wait for the export button to confirm the inventory table has rendered
    await page.waitForSelector('button.btn-outline-secondary', { timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log(`  Inventory loaded. URL: ${page.url()}`);

    // ── Step 3: Open the export panel ────────────────────────────────────────
    console.log('Opening export panel...');
    await page.screenshot({ path: screenshotPath }); // screenshot of inventory page

    // The export button is a .btn-outline-secondary (top-right, no visible text).
    // Log all btn-outline-secondary buttons so we can see what's available.
    const allExportBtns = page.locator('button.btn-outline-secondary');
    const btnCount = await allExportBtns.count();
    console.log(`  Found ${btnCount} btn-outline-secondary button(s)`);
    for (let i = 0; i < btnCount; i++) {
      const txt  = await allExportBtns.nth(i).innerText().catch(() => '');
      const ttip = await allExportBtns.nth(i).getAttribute('title').catch(() => '');
      console.log(`    [${i}] text="${txt.trim()}" title="${ttip}"`);
    }

    // Click the last one (top-right export button based on user description)
    await allExportBtns.last().click();
    await page.waitForTimeout(2000);

    // Screenshot after panel opens so we can see what appeared
    const panelScreenshot = path.join(os.tmpdir(), 'sostocked-panel.png');
    await page.screenshot({ path: panelScreenshot, fullPage: true });
    console.log(`  Panel screenshot saved to: ${panelScreenshot}`);

    // ── Step 4: Download the CSV ──────────────────────────────────────────────
    // Intercept the network response as a fallback — SoStocked may deliver the
    // file via a response rather than triggering a browser download event.
    console.log('Clicking Download...');
    const csvPath = path.join(os.tmpdir(), 'sos_1pa_export.csv');
    let csvSavedViaResponse = false;

    page.on('response', async response => {
      if (csvSavedViaResponse) return;
      const cd = response.headers()['content-disposition'] ?? '';
      const ct = response.headers()['content-type'] ?? '';
      if (cd.includes('attachment') || ct.includes('csv') || ct.includes('spreadsheet') || ct.includes('excel')) {
        try {
          const body = await response.body();
          fs.writeFileSync(csvPath, body);
          csvSavedViaResponse = true;
          console.log(`  CSV captured via network response (${body.length} bytes)`);
        } catch { /* ignore race */ }
      }
    });

    // Try button first, then link
    const downloadEl = page.getByRole('button', { name: /download/i })
      .or(page.getByRole('link', { name: /download/i }))
      .first();

    const [dlEvent] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
      downloadEl.click(),
    ]);

    if (dlEvent) {
      await dlEvent.saveAs(csvPath);
      console.log(`  Downloaded via browser event to: ${csvPath}`);
    } else if (csvSavedViaResponse) {
      console.log(`  CSV saved via response interception`);
    } else {
      // Give the response handler a moment to fire
      await page.waitForTimeout(5000);
      if (!csvSavedViaResponse) {
        throw new Error('Download did not complete — check panel screenshot artifact');
      }
    }

    // ── Step 5: Parse and filter CSV ─────────────────────────────────────────
    console.log('Parsing and filtering CSV...');
    const text     = fs.readFileSync(csvPath, 'utf-8');
    const rows     = parseCSV(text);
    const header   = rows[0] ?? [];
    const filtered = [
      header,
      ...rows.slice(1).filter(r => r.length >= 3 && SPINCARE_ASINS.has((r[2] ?? '').trim())),
    ];
    console.log(`  Total rows: ${rows.length}, Spincare rows (inc. header): ${filtered.length}`);

    if (filtered.length < 10 || filtered.length > 200) {
      throw new Error(
        `Unexpected filtered row count: ${filtered.length}. Expected ~85. ` +
        `Check ASIN list or export format.`,
      );
    }

    // ── Step 6: Write to Google Sheets ───────────────────────────────────────
    console.log('\nConnecting to Google Sheets...');
    const auth   = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range:         `${TAB_NAME}!A:ZZ`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId:    SPREADSHEET_ID,
      range:            `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody:      { values: filtered },
    });

    console.log(`\nDone — ${filtered.length - 1} Spincare row(s) written to "${TAB_NAME}".`);
    console.log(`View: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

  } catch (err) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.error(`\nFailed. Debug screenshot saved to: ${screenshotPath}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
