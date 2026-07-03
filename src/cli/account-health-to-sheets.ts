#!/usr/bin/env tsx
// Fetches Amazon Account Health for all EU marketplaces via GET_V1_SELLER_PERFORMANCE_REPORT
// and appends a weekly snapshot row (one column per marketplace) to the "Account Health" tab.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const TAB_NAME = 'Account Health';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const MARKETPLACES = [
  { label: 'GB', id: 'A1F83G8C2ARO7P' },
  { label: 'DE', id: 'A1PA6795UKMFR9' },
  { label: 'FR', id: 'A13V1IB3VIYZZH' },
  { label: 'IT', id: 'APJ6JRA9NG5V4' },
  { label: 'ES', id: 'A1RKKUPIHCS9HS' },
  { label: 'NL', id: 'A1805IZSGTT6HS' },
  { label: 'IE', id: 'A28R8C7NBKEWEA' },
  { label: 'BE', id: 'AMEN7PMS3EDWL' },
  { label: 'SE', id: 'A2NODRKZP88ZB9' },
];

interface HealthMetrics {
  overall: string;
  odrRate: string;
  lateShipmentRate: string;
  cancellationRate: string;
  returnDissatisfactionRate: string;
}

function statusScore(status: string): string {
  if (status === 'Good') return '1000';
  if (status === 'Fair') return '500';
  if (status === 'Poor') return '0';
  return 'N/A';
}

function parseHealthXml(xml: string): HealthMetrics {
  // Extract overall status from the performanceChecklist
  const checklist = xml.match(/<performanceChecklist>([\s\S]*?)<\/performanceChecklist>/)?.[1] ?? '';
  const statuses = [...checklist.matchAll(/<status>([\s\S]*?)<\/status>/g)].map(m => m[1]!.trim());
  const overallStatus = statuses.includes('Poor') ? 'Poor'
    : statuses.includes('Fair') ? 'Fair'
    : statuses.length > 0 ? 'Good' : 'N/A';
  const overall = statusScore(overallStatus);

  // Helper: extract rate from the LAST occurrence of a metrics block/field
  const getLastRate = (blockTag: string, rateTag: string): string => {
    const blocks = [...xml.matchAll(new RegExp(`<${blockTag}>([\\s\\S]*?)<\\/${blockTag}>`, 'g'))];
    const last = blocks[blocks.length - 1]?.[1] ?? '';
    return last.match(new RegExp(`<${rateTag}>[\\s\\S]*?<rate>([\\s\\S]*?)<\\/rate>`))?.[1]?.trim() ?? 'N/A';
  };

  return {
    overall,
    odrRate: getLastRate('orderDefectMetrics', 'orderWithDefects'),
    lateShipmentRate: getLastRate('customerExperienceMetrics', 'lateShipment'),
    cancellationRate: getLastRate('customerExperienceMetrics', 'preFulfillmentCancellation'),
    returnDissatisfactionRate: getLastRate('returnDissatisfactionMetrics', 'returnDissatisfaction'),
  };
}

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

  console.log(`Step 1: Fetching health reports for all ${MARKETPLACES.length} marketplaces sequentially...`);

  const results: PromiseSettledResult<{ label: string; metrics: HealthMetrics }>[] = [];
  for (let i = 0; i < MARKETPLACES.length; i++) {
    const m = MARKETPLACES[i]!;
    try {
      const report = await runReport(spClient, {
        reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT',
        marketplaceIds: [m.id],
      });
      // Log first 1000 chars so we can see the V2 format and fix parsing if needed
      if (i === 0) console.log(`  [${m.label}] V2 raw sample:\n${report.rawText.slice(0, 1000)}\n`);
      results.push({ status: 'fulfilled', value: { label: m.label, metrics: parseHealthXml(report.rawText) } });
    } catch (err) {
      results.push({ status: 'rejected', reason: err });
    }
    if (i < MARKETPLACES.length - 1) {
      console.log('  Waiting 15s before next marketplace...');
      await new Promise(r => setTimeout(r, 15_000));
    }
  }

  const metricsMap: Record<string, HealthMetrics | null> = {};
  for (let i = 0; i < MARKETPLACES.length; i++) {
    const m = MARKETPLACES[i]!;
    const r = results[i]!;
    if (r.status === 'fulfilled') {
      metricsMap[m.label] = r.value.metrics;
      console.log(`  ${m.label}: ${r.value.metrics.overall}`);
    } else {
      metricsMap[m.label] = null;
      console.log(`  ${m.label}: FAILED — ${String(r.reason).slice(0, 100)}`);
    }
  }

  const labels = MARKETPLACES.map(m => m.label);
  const val = (label: string, key: keyof HealthMetrics) => metricsMap[label]?.[key] ?? 'N/A';

  // One row per metric type, matching the multi-column table format from the image
  const overallRow    = [today, ...labels.map(l => val(l, 'overall'))];
  const odrRow        = [today, ...labels.map(l => val(l, 'odrRate'))];
  const lateShipRow   = [today, ...labels.map(l => val(l, 'lateShipmentRate'))];
  const cancelRow     = [today, ...labels.map(l => val(l, 'cancellationRate'))];
  const returnRow     = [today, ...labels.map(l => val(l, 'returnDissatisfactionRate'))];

  const HEADER = ['snapshot_date', ...labels];

  console.log('\nStep 2: Writing to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Create "Account Health" tab if it doesn't exist
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabExists = spreadsheet.data.sheets?.some(s => s.properties?.title === TAB_NAME);
  if (!tabExists) {
    console.log(`  Creating "${TAB_NAME}" tab...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
  }

  // Read current content to decide whether to write section headers or just append
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
  });
  const isEmpty = (existing.data.values?.[0]?.[0] ?? '') === '';

  let rowsToWrite: string[][];
  let writeRange: string;

  if (isEmpty) {
    // First run: write full layout with section labels
    rowsToWrite = [
      ['OVERALL ACCOUNT HEALTH'],
      HEADER,
      overallRow,
      [],
      ['ORDER DEFECT RATE (90-day)'],
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
      ['RETURN DISSATISFACTION RATE (30-day)'],
      HEADER,
      returnRow,
    ];
    writeRange = `${TAB_NAME}!A1`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: writeRange,
      valueInputOption: 'RAW',
      requestBody: { values: rowsToWrite },
    });
  } else {
    // Subsequent runs: find each section and append the new data row below it
    const allCells = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A:A`,
    });
    const colA = (allCells.data.values ?? []).map(r => (r[0] ?? '') as string);

    const appendSection = async (sectionLabel: string, newRow: string[]) => {
      const sectionIdx = colA.findIndex(v => v === sectionLabel);
      if (sectionIdx === -1) return;
      // Data starts 2 rows after section label (label + header = +2), find next blank
      let insertAt = sectionIdx + 3; // default: row after header
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

    await appendSection('OVERALL ACCOUNT HEALTH', overallRow);
    await appendSection('ORDER DEFECT RATE (90-day)', odrRow);
    await appendSection('LATE SHIPMENT RATE (30-day)', lateShipRow);
    await appendSection('PRE-FULFILLMENT CANCELLATION RATE (30-day)', cancelRow);
    await appendSection('RETURN DISSATISFACTION RATE (30-day)', returnRow);
  }

  console.log(`  Done — "${TAB_NAME}" tab updated`);
  console.log('\nView: https://docs.google.com/spreadsheets/d/1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
