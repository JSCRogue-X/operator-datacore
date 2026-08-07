#!/usr/bin/env tsx
// Fetches the official gov.uk bank holidays feed (England & Wales) and keeps
// the "Bank Holidays" tab as a rolling 3-year window (current year + next 2),
// adding newly-published dates and a Christmas Eve entry (Ogden-specific
// closure, not a statutory bank holiday) for each year, and dropping any
// year that's fallen out of the window — so the tab never grows past
// 3 years' worth of dates.
// Run: npx tsx src/cli/bank-holidays-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1LSCRaHwsLBUFAg7DuRAaa8L5wDOfB7upQZ4Hb7-sayo';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Bank Holidays';
const GOV_UK_FEED = 'https://www.gov.uk/bank-holidays.json';
const WINDOW_YEARS = 3; // current year + next 2

const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
function toSheetDate(isoDate: string): number {
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - SHEETS_EPOCH) / 86400000);
}
function yearOfSerial(serial: number): number {
  return new Date(SHEETS_EPOCH + serial * 86400000).getUTCFullYear();
}

interface GovUkEvent { title: string; date: string; }
interface GovUkFeed { 'england-and-wales': { events: GovUkEvent[] } }

async function main() {
  console.log('Bank Holidays → Google Sheets (rolling 3-year window)');
  console.log('-------------------------------------------------------');

  const startYear = new Date().getFullYear();
  const endYear   = startYear + WINDOW_YEARS - 1;
  console.log(`Window: ${startYear}-${endYear}`);

  console.log('Fetching gov.uk bank holidays feed...');
  const resp = await fetch(GOV_UK_FEED);
  if (!resp.ok) throw new Error(`gov.uk feed failed: ${resp.status}`);
  const data = await resp.json() as GovUkFeed;
  const events = (data['england-and-wales']?.events ?? [])
    .filter(e => {
      const y = Number(e.date.slice(0, 4));
      return y >= startYear && y <= endYear;
    });
  console.log(`  ${events.length} bank holiday(s) in the ${startYear}-${endYear} window from the feed.`);

  // Candidates: every official bank holiday in the window, plus a Christmas
  // Eve entry for each distinct year the feed has confirmed within it.
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

  // Only real date rows — skips the spacer/note rows at the bottom — and only
  // ones still inside the rolling window; anything from a year that's dropped
  // out gets left behind here (i.e. removed).
  const keptDateRows: { serial: number; name: string }[] = [];
  let droppedCount = 0;
  for (const r of existingRows) {
    const serial = Number(r?.[0]);
    if (isNaN(serial) || serial <= 0) continue;
    const y = yearOfSerial(serial);
    if (y >= startYear && y <= endYear) {
      keptDateRows.push({ serial, name: String(r?.[1] ?? '') });
    } else {
      droppedCount++;
    }
  }
  const keptSerials = new Set(keptDateRows.map(r => r.serial));
  console.log(`  ${keptDateRows.length} existing date(s) kept, ${droppedCount} dropped (outside the window).`);

  const newCandidates = candidates.filter(c => !keptSerials.has(toSheetDate(c.date)));
  console.log(`  ${newCandidates.length} new date(s) to add.`);

  if (newCandidates.length === 0 && droppedCount === 0) {
    console.log('  Already up to date — nothing to add or remove.');
    return;
  }

  const allDateRows = [
    ...keptDateRows.map(r => [r.serial, r.name] as [number, string]),
    ...newCandidates.map(c => [toSheetDate(c.date), c.name] as [number, string]),
  ].sort((a, b) => a[0] - b[0]);

  const noteRow = [
    `Note: rolling ${WINDOW_YEARS}-year window (${startYear}-${endYear}) — this script (bank-holidays-to-sheets.ts) adds new dates and drops old years automatically each run. Christmas Eve is added automatically alongside each year's official dates (Ogden-specific closure, not a statutory bank holiday).`,
  ];

  const fullValues: (string | number)[][] = [
    ['Date', 'Name'],
    ...allDateRows,
    [],
    noteRow,
  ];

  // Clear the whole tab first — the window can shrink (old year dropped),
  // and values.update alone would leave stale rows behind past the new content.
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: TAB_NAME });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: fullValues },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell:   { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        {
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
        },
      ],
    },
  });

  console.log(`  Done — ${newCandidates.length} added, ${droppedCount} dropped. "${TAB_NAME}" now has ${allDateRows.length} date(s) total.`);
}

main().catch(err => { console.error(err); process.exit(1); });
