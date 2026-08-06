#!/usr/bin/env tsx
// Fetches the official gov.uk bank holidays feed (England & Wales) and keeps
// the "Bank Holidays" tab up to date — adding any newly-published bank
// holiday dates automatically, plus a Christmas Eve entry (Ogden-specific
// closure, not a statutory bank holiday) for every year gov.uk has confirmed.
// Only dates from 2026 onwards are kept (matches the Linn tab's data range).
// Run: npx tsx src/cli/bank-holidays-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1LSCRaHwsLBUFAg7DuRAaa8L5wDOfB7upQZ4Hb7-sayo';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Bank Holidays';
const GOV_UK_FEED = 'https://www.gov.uk/bank-holidays.json';
const EARLIEST_YEAR = 2026;

const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
function toSheetDate(isoDate: string): number {
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - SHEETS_EPOCH) / 86400000);
}

interface GovUkEvent { title: string; date: string; }
interface GovUkFeed { 'england-and-wales': { events: GovUkEvent[] } }

async function main() {
  console.log('Bank Holidays → Google Sheets');
  console.log('-------------------------------');

  console.log('Fetching gov.uk bank holidays feed...');
  const resp = await fetch(GOV_UK_FEED);
  if (!resp.ok) throw new Error(`gov.uk feed failed: ${resp.status}`);
  const data = await resp.json() as GovUkFeed;
  const events = (data['england-and-wales']?.events ?? [])
    .filter(e => Number(e.date.slice(0, 4)) >= EARLIEST_YEAR);
  console.log(`  ${events.length} bank holiday(s) from ${EARLIEST_YEAR} onwards in the feed.`);

  // Candidates: every official bank holiday from the feed, plus a Christmas
  // Eve entry for each distinct year the feed has confirmed.
  const years = new Set(events.map(e => e.date.slice(0, 4)));
  const candidates: { date: string; name: string }[] = events.map(e => ({ date: e.date, name: e.title }));
  for (const year of years) {
    candidates.push({ date: `${year}-12-24`, name: 'Christmas Eve (Ogden closure)' });
  }

  // ── Google Sheets ──────────────────────────────────────────────────────
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const ss = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetInfo = ss.data.sheets?.find(s => s.properties?.title === TAB_NAME);
  if (!sheetInfo) throw new Error(`"${TAB_NAME}" tab not found`);
  const sheetId = sheetInfo.properties?.sheetId ?? 0;

  const existingResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A2:B`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const existingRows = existingResp.data.values ?? [];

  // Only real date rows — skips the spacer/note rows at the bottom
  const existingDateRows: { serial: number; name: string }[] = [];
  for (const r of existingRows) {
    const serial = Number(r?.[0]);
    if (!isNaN(serial) && serial > 0) existingDateRows.push({ serial, name: String(r?.[1] ?? '') });
  }
  const existingSerials = new Set(existingDateRows.map(r => r.serial));
  console.log(`  ${existingDateRows.length} existing date(s) already in "${TAB_NAME}".`);

  const newCandidates = candidates.filter(c => !existingSerials.has(toSheetDate(c.date)));
  console.log(`  ${newCandidates.length} new date(s) to add.`);

  if (newCandidates.length === 0) {
    console.log('  Already up to date — nothing to add.');
    return;
  }

  const allDateRows = [
    ...existingDateRows.map(r => [r.serial, r.name] as [number, string]),
    ...newCandidates.map(c => [toSheetDate(c.date), c.name] as [number, string]),
  ].sort((a, b) => a[0] - b[0]);

  const latestYear = Math.max(...allDateRows.map(r => new Date(SHEETS_EPOCH + r[0] * 86400000).getUTCFullYear()));
  const noteRow = [
    `Note: dates through ${latestYear} are published by gov.uk as of this run — this script (bank-holidays-to-sheets.ts) checks for new ones automatically. Christmas Eve is added automatically alongside each year's official dates (Ogden-specific closure, not a statutory bank holiday).`,
  ];

  const fullValues: (string | number)[][] = [
    ['Date', 'Name'],
    ...allDateRows,
    [],
    noteRow,
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: fullValues },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex:    1,
            endRowIndex:      1 + allDateRows.length,
            startColumnIndex: 0,
            endColumnIndex:   1,
          },
          cell:   { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      }],
    },
  });

  console.log(`  Done — ${newCandidates.length} new date(s) added. "${TAB_NAME}" now has ${allDateRows.length} date(s) total.`);
}

main().catch(err => { console.error(err); process.exit(1); });
