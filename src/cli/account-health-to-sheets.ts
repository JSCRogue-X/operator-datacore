#!/usr/bin/env tsx
// Fetches Amazon Account Health for all EU marketplaces and appends a weekly
// snapshot row (one column per marketplace) to the "Account Health" tab.
// A single GET_V2_SELLER_PERFORMANCE_REPORT call returns all marketplaces at once.
// Run: npx tsx src/cli/account-health-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const TAB_NAME = 'Account Health';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

// Ordered list of marketplaces to show as columns in the sheet
const MARKETPLACES = [
  { label: 'GB', id: 'A1F83G8C2ARO7P' },
  { label: 'DE', id: 'A1PA6795UKMFR9' },
  { label: 'FR', id: 'A13V1IB3VIYZZH' },
  { label: 'IT', id: 'APJ6JRA9NG5V4'  },
  { label: 'ES', id: 'A1RKKUPIHCS9HS' },
  { label: 'NL', id: 'A1805IZSGTT6HS' },
  { label: 'IE', id: 'A28R8C7NBKEWEA' },
  { label: 'BE', id: 'AMEN7PMS3EDWL'  },
  { label: 'SE', id: 'A2NODRKZP88ZB9' },
  { label: 'PL', id: 'A1C3SOZRARQ6R3' },
  { label: 'TR', id: 'A33AVAJ2PDY3EV' },
];

interface HealthMetrics {
  ahrScore:         string;  // 0–1000
  ahrStatus:        string;  // GREAT / GOOD / AT_RISK / CRITICAL
  odrRate:          string;  // AFN order defect rate (decimal)
  lateShipmentRate: string;
  cancellationRate: string;
  policyWarnings:   string;  // count of live policy warnings
}

interface PerfMetric {
  marketplaceId: string;
  accountHealthRating?:          { ahrScore: number; ahrStatus: string };
  lateShipmentRate?:             { rate: number };
  orderDefectRate?:              { afn?: { rate: number }; mfn?: { rate: number } };
  preFulfillmentCancellationRate?: { rate: number };
  policyViolationWarnings?:      { warningsCount: number };
}

function extractMetrics(m: PerfMetric): HealthMetrics {
  const str = (n: number | undefined): string => n !== undefined ? String(n) : 'N/A';
  return {
    ahrScore:         str(m.accountHealthRating?.ahrScore),
    ahrStatus:        m.accountHealthRating?.ahrStatus ?? 'N/A',
    odrRate:          str(m.orderDefectRate?.afn?.rate),
    lateShipmentRate: str(m.lateShipmentRate?.rate),
    cancellationRate: str(m.preFulfillmentCancellationRate?.rate),
    policyWarnings:   str(m.policyViolationWarnings?.warningsCount),
  };
}

const EMPTY_METRICS: HealthMetrics = {
  ahrScore: 'N/A', ahrStatus: 'N/A', odrRate: 'N/A',
  lateShipmentRate: 'N/A', cancellationRate: 'N/A', policyWarnings: 'N/A',
};

async function main() {
  console.log('Account Health → Google Sheets');
  console.log('--------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const today = new Date().toISOString().slice(0, 10);

  // One report call returns all EU marketplaces in a single response
  console.log('Requesting GET_V2_SELLER_PERFORMANCE_REPORT (single call covers all marketplaces)...');
  const report = await runReport(spClient, {
    reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT',
    marketplaceIds: ['A1F83G8C2ARO7P'], // GB as trigger — response always includes all EU
  });

  const data = JSON.parse(report.rawText) as { performanceMetrics: PerfMetric[] };
  const byId = new Map<string, HealthMetrics>(
    (data.performanceMetrics ?? []).map(m => [m.marketplaceId, extractMetrics(m)]),
  );

  console.log(`Parsed ${byId.size} marketplace(s) from report.`);
  for (const mkt of MARKETPLACES) {
    const m = byId.get(mkt.id) ?? EMPTY_METRICS;
    console.log(`  ${mkt.label}: AHR ${m.ahrScore} (${m.ahrStatus})`);
  }

  const labels  = MARKETPLACES.map(m => m.label);
  const val     = (label: string, key: keyof HealthMetrics) =>
    (byId.get(MARKETPLACES.find(m => m.label === label)!.id) ?? EMPTY_METRICS)[key];

  const HEADER       = ['snapshot_date', ...labels];
  const ahrScoreRow  = [today, ...labels.map(l => val(l, 'ahrScore'))];
  const ahrStatusRow = [today, ...labels.map(l => val(l, 'ahrStatus'))];
  const odrRow       = [today, ...labels.map(l => val(l, 'odrRate'))];
  const lateShipRow  = [today, ...labels.map(l => val(l, 'lateShipmentRate'))];
  const cancelRow    = [today, ...labels.map(l => val(l, 'cancellationRate'))];
  const warningsRow  = [today, ...labels.map(l => val(l, 'policyWarnings'))];

  console.log('\nWriting to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Create tab if it doesn't exist
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabExists = spreadsheet.data.sheets?.some(s => s.properties?.title === TAB_NAME);
  if (!tabExists) {
    console.log(`  Creating "${TAB_NAME}" tab...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
  }

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
  });
  const isEmpty = (existing.data.values?.[0]?.[0] ?? '') === '';

  if (isEmpty) {
    const rowsToWrite = [
      ['OVERALL AHR SCORE (0-1000)'],
      HEADER,
      ahrScoreRow,
      [],
      ['AHR STATUS'],
      HEADER,
      ahrStatusRow,
      [],
      ['ORDER DEFECT RATE - AFN (90-day)'],
      HEADER,
      odrRow,
      [],
      ['LATE SHIPMENT RATE (30-day)'],
      HEADER,
      lateShipRow,
      [],
      ['PRE-FULFILLMENT CANCELLATION RATE (30-day)'],
      HEADER,
      cancelRow,
      [],
      ['POLICY WARNINGS'],
      HEADER,
      warningsRow,
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rowsToWrite },
    });
  } else {
    const allCells = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A:A`,
    });
    const colA = (allCells.data.values ?? []).map(r => (r[0] ?? '') as string);

    const appendSection = async (sectionLabel: string, newRow: (string | number)[]) => {
      const sectionIdx = colA.findIndex(v => v === sectionLabel);
      if (sectionIdx === -1) return;
      let insertAt = sectionIdx + 3;
      for (let i = sectionIdx + 2; i < colA.length; i++) {
        if (colA[i] === '' || colA[i] === undefined) { insertAt = i + 1; break; }
        insertAt = i + 2;
      }
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${TAB_NAME}!A${insertAt}`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [newRow] },
      });
    };

    await appendSection('OVERALL AHR SCORE (0-1000)', ahrScoreRow);
    await appendSection('AHR STATUS', ahrStatusRow);
    await appendSection('ORDER DEFECT RATE - AFN (90-day)', odrRow);
    await appendSection('LATE SHIPMENT RATE (30-day)', lateShipRow);
    await appendSection('PRE-FULFILLMENT CANCELLATION RATE (30-day)', cancelRow);
    await appendSection('POLICY WARNINGS', warningsRow);
  }

  console.log(`  Done — "${TAB_NAME}" tab updated.`);
  console.log('\nView: https://docs.google.com/spreadsheets/d/1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
