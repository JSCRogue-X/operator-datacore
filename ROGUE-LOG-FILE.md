# Rogue Log File

Running log of sessions, decisions, and changes made to operator-datacore.

---

## Session Log

### 23 July 2026

**Disposals Update: redirected to Disposals V2.3, dedup-append, J→P Cost Static copy**
- Target changed: Disposals V2.3 (`1GC9MZxpMhmhw8QGi8-dAhXsruwbBhpsQEaWR9RLdMZE`), tab "Disposals Data"
- Replaced clear-and-overwrite with dedup-append (dedup key: Order ID + SKU)
- After appending new rows A–I, waits 3 seconds for Sheets to compute column J (EUR>GBP formula)
- Reads column J with `valueRenderOption: 'UNFORMATTED_VALUE'` and writes values as static numbers into column P (Cost Static)
- Removed `IPI_SHEET_ID` env var from `disposals.yml` workflow
- Schedule unchanged: Monday 6:30am UTC

**FBA Customer Returns → Sheets: redirected to Amazon Returns 3.0**
- Target changed: Amazon Returns 3.0 (`1914IxosqiCMMQO1-UsePsjaHurB_6g16AQuh-y6TZD0`), tab "Amazon Data"
- Replaced clear-and-overwrite with dedup-append (dedup key: License Plate Number)
- Preserves existing 8,958+ rows of data already in the sheet

**Amazon Shipments → Sheets: aborted and removed**
- Attempted to build using SP-API Fulfillment Inbound v0 (0 results — old API doesn't see new plan-based shipments)
- Rewrote for v2024-03-20 `listInboundPlans` → `listShipments`, but `listShipments` returned 403 Unauthorized
- Root cause: refresh token likely needs re-authorisation in Seller Central after adding Fulfillment Inbound role
- Decision: removed script and workflow from GitHub rather than wait; can be rebuilt after app re-authorisation

**Decisions**
- Column J → P freeze pattern: Sheets API computes formulas server-side; read with `UNFORMATTED_VALUE` after a delay to get the numeric result
- SP-API v0 inbound API does not see shipments created via the new v2024-03-20 plan workflow

**Files changed**
- `src/cli/disposals-to-sheets.ts` — full rewrite (new target, dedup-append, J→P copy)
- `.github/workflows/disposals.yml` — removed `IPI_SHEET_ID`
- `src/cli/returns-to-sheets.ts` — new target, dedup-append
- `.github/workflows/returns-to-sheets.yml` — removed `IPI_SHEET_ID`
- `src/cli/amazon-shipments-to-sheets.ts` — DELETED
- `.github/workflows/amazon-shipments-to-sheets.yml` — DELETED

---

**New script: amazon-shipments-to-sheets.ts**
- Pulls active FBA inbound shipments for UK and DE marketplaces from SP-API Fulfillment Inbound v0
- Writes to "Shipments" tab in Automations spreadsheet (`1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4`)
- Columns: Shipment name, Shipment ID, Status, Created at, Last updated, Ship to, SKUs, Units
- Fetches items per shipment (GetShipmentItemsByShipmentId) to compute SKU count and Units (received/total format e.g. "0/5880")
- Deduplicates by ShipmentId across UK and DE (Pan-EU shipments appear in both)
- Filters: AGL shipments excluded by name check; CLOSED/CANCELLED/DELETED excluded by not querying those statuses
- Status formatted as human-readable: IN_TRANSIT → "In transit", READY_TO_SHIP → "Ready to ship", etc.
- Sorted alphabetically by shipment name
- Clear-and-overwrite pattern (statuses change frequently, no need to preserve old data)
- Credentials read directly from `process.env` (same pattern as amazon-de-price — avoids Supabase env validation)

**Known limitation**
- "Created at" and "Last updated" columns are blank — FBA Inbound v0 API does not return timestamps; would need the v2024-03-20 Fulfillment Inbound API to populate these

**Files created**
- `src/cli/amazon-shipments-to-sheets.ts` — new script
- `.github/workflows/amazon-shipments-to-sheets.yml` — standalone workflow_dispatch

---

### 21 July 2026

**Numeric columns fixed — Extended Props and Replen scripts**
- Extended Props: 11 columns now written as real numbers (BarcodeNumber via `numStr`, HSTariffCode, CommodityCode, SC-CartonWeight, SC-PalletQuantity, CaseSize, SC-PalletCartons, CBM, Max Level, UnitQuantity, SC-PalletQuantity-DE via `numExt`)
- Replen: CommodityCode fixed (was `ext()`, now `numExt()`)
- Standing rule established: all numeric columns written as numbers, dates as proper date values — never plain strings

**New script: linnworks-fba-ih-linking-to-sheets.ts**
- Writes FBA IH Linking data to `LinkFile New` tab in FBA IH Linking File spreadsheet
- Columns: Amazon FBA SKU, Barcode, SKU, ASIN, Title, Supplier, IH Cost, FBA UK Cost, FBA EU Cost, IH Buffer
- Several iterative fixes during testing:
  - IH Cost: `FBA_UK_Inbound_Cost` → `item.PurchasePrice` → `item.Suppliers[0].PurchasePrice` (base response always returns 0; actual value is in the supplier record)
  - FBA UK Cost: added as new column; source changed `Inbound` → `Landed`
  - FBA EU Cost: source changed `Inbound` → `Landed`
  - Supplier: `ext('SC-SupplierCode')` → `ext('Supplier')` → `item.Suppliers[0]['Supplier']` (supplier name from Suppliers record, not extended properties)
  - `dataRequirements` updated to include `'Supplier'` so supplier record is populated

**New script: amazon-de-price-to-sheets.ts**
- Pulls `GET_FBA_INVENTORY_PLANNING_DATA` for DE marketplace (`A1PA6795UKMFR9`)
- Writes SKU, FNSKU, ASIN, Product Name, Condition, Price, Marketplace Country Code to `[DO NOT DELETE] Amazon DE Price` tab in FBA IH Linking File
- Fix: removed `loadEnvForAmazon()` — it triggered Supabase schema validation which fails when only SP-API secrets are present; reads credentials directly from `process.env` instead

**Decisions**
- Purchase price in Linnworks is stored on the supplier record (`Suppliers[0].PurchasePrice`), not on the stock item's base `PurchasePrice` field (which always returns 0 from `GetStockItemsFull`)
- Both new Linnworks scripts are standalone `workflow_dispatch`-only workflows

**Files created/changed**
- `src/cli/linnworks-fba-ih-linking-to-sheets.ts` — new script (multiple fixes)
- `src/cli/amazon-de-price-to-sheets.ts` — new script
- `src/cli/linnworks-extended-props-to-sheets.ts` — 11 numeric column fixes
- `src/cli/linnworks-replen-to-sheets.ts` — CommodityCode numeric fix
- `.github/workflows/linnworks-fba-ih-linking-to-sheets.yml` — new workflow
- `.github/workflows/amazon-de-price-to-sheets.yml` — new workflow

---

### 20 July 2026

**Linnworks OOS Days Analysis → Google Sheets — new script, fully working**
- New Python script `linnworks_oos.py` + GitHub Actions workflow `linnworks-oos-analysis.yml`
- Calculates total OOS days per SKU at Ogden Fulfilment over a 3-year window, broken down by year
- Writes Summary (SKU, Title, Total OOS Days, 2023–2026 columns) + Detail (per OOS period) to "Output" tab in Linnworks sheet
- Run manually via `workflow_dispatch` in GitHub Actions

**Bugs fixed during build (all in `linnworks_oos.py`)**
- Auth: `data["AccessToken"]` → `data["Token"]` — Linnworks returns session token in `Token` field
- History method: `GetItemChangesHistory` is a GET endpoint; POST returns 400
- Location: endpoint silently requires `locationId` — fetches Ogden Fulfilment GUID at startup via `GetInventory/GetStockLocations`
- pageNumber: must be ≥ 1; spec claim that `-1` returns all pages is wrong
- Stock items endpoint: switched from `GetStockItems` (no SKU/Title) to `GetStockItemsFull` (POST)
- Response structure: `GetStockItemsFull` returns a plain list, not `{"Data": [...]}` 
- SKU field: `GetStockItemsFull` uses `ItemNumber`, not `SKU`

**Decisions**
- History pulled from Ogden Fulfilment location only (not FBA locations)
- No scheduling set up — run on demand
- Jon confirmed working as expected: 86 SKUs, 128 OOS periods, SKU + Title + per-year breakdown all correct in Output tab

**Files created/changed**
- `linnworks_oos.py` — new Python OOS analysis script
- `.github/workflows/linnworks-oos-analysis.yml` — new GitHub Actions workflow
- `.gitignore` — added `linnworks_oos_*.xlsx`

---

### 17 July 2026

**linnworks-30-day-sales-to-sheets — fully complete and redirected to IHS2**
- Correct Linnworks items endpoint discovered: `POST Orders/GetOrderById` with `{ pkOrderId: guid }` — items in `data.Items[]`
- Item fields confirmed: `SKU`, `Quantity`
- Script now aggregates by ISO week start (Monday) + SKU across eBay + Shopify combined
- Columns: Week Start (DD-MM-YYYY date value), Year, Month, Week No., SKU, Total Units
- Week Start written as Google Sheets serial integer; column A formatted as `DD-MM-YYYY` via `repeatCell`
- Target changed: appends to **IHS2** tab in Company Sell-through Tracker V2.1 (`1mIk4mrFisXIpen2zZpnmxHWDRtmbjX6Ikyao_EzWZ3M`) — no longer writes to Linnworks sheet
- Uses `values.append` with `INSERT_ROWS` — adds to next available row each month, no clearing

**IH Sales historical backfill — ih-sales-to-ihs2.ts**
- One-off script: reads all 15,231 rows from IH Sales tab, aggregates by week + SKU, writes 1,949 rows to IHS2
- Same column structure as the monthly Linnworks script
- Run locally (not a GitHub Actions workflow)

**Numeric and date formatting — all Linnworks scripts**
- All six Linnworks scripts updated: numeric fields (stock, quantities, prices, dimensions) now written as numbers, not strings
- OOS dates changed from "12 Jul 2026" to DD/MM/YYYY; `daysSince()` handles both formats for backward compatibility
- `replen` and `extended-props`: `num()` helper now returns `number | ''` instead of `string`
- `ih-stock`: weekNum and year now written as numbers

**Decisions**
- Source (eBay/Shopify) dropped from aggregation — combined into single total per SKU per week
- Append-only to IHS2 so historical data from ih-sales-to-ihs2.ts backfill is preserved

**Next session**
- Historical backfill: add `--year`/`--month` CLI args to `linnworks-30-day-sales-to-sheets.ts` so older months can be run individually to fill in data before the backfill start date

**Files changed**
- `src/cli/linnworks-30-day-sales-to-sheets.ts` — endpoint fix, weekly aggregation, IHS2 target, append mode
- `src/cli/ih-sales-to-ihs2.ts` — new backfill script
- `src/cli/linnworks-oos-to-sheets.ts` — date format DD/MM/YYYY, numbers as numbers
- `src/cli/linnworks-replen-to-sheets.ts` — num() helper returns numbers
- `src/cli/linnworks-extended-props-to-sheets.ts` — same
- `src/cli/linnworks-company-st-to-sheets.ts` — Available/MinimumLevel as numbers
- `src/cli/linnworks-ih-stock-to-sheets.ts` — weekNum/year as numbers

---

### 15 July 2026 (continued)

**Linnworks OOS → Google Sheets — category + never-stocked filters added (confirmed working)**
- Final result: 5 items in sheet (was 33 before filters)
- Filter 1: `CategoryName === 'SPINCARE'` — top-level field on stock item response
- Filter 2: Never stocked — excluded if `GetItemChangesHistory` contains no `Level > 0` entry
- Both filters applied from scratch on a cleared sheet — dates confirmed accurate (oldest: 10 Jan 2024)

**Linnworks OOS → Google Sheets — history dates now fully working**
- 33/33 items received real historical OOS dates from `GetItemChangesHistory`
- Root cause of history returning null: two separate bugs fixed in sequence:
  1. `LINNWORKS_LOCATION_KEY` is stored as a name ("Ogden Fulfilment") — history API needs the GUID. Fixed by capturing `StockLocationId` from the first matched `StockLevels` entry in `fetchOosItems` and passing that GUID to `findFirstOosDate`.
  2. History entry field for stock level is `Level`, not `StockLevel`/`Available`/`Qty`.
- Confirmed field names: `StockItemId`, `Date`, `Level`, `StockValue`, `Note`, `ChangeQty`, `ChangeValue`
- Final log: "33 new item(s), 33 with a real OOS date, 0 defaulted to today"

**Linnworks OOS → Google Sheets — initial working version**
- Script writes 33 OOS items to "IH OOS" tab in sheet `1sF1lxqJMKJQpnsK3q6e7zzcDSucBDUsl0CHfwkocqcQ`
- Root cause of 400 errors: `GetStockItemsFull` requires ALL documented parameters to be present, even optional ones — omitting any caused "The request is invalid."
- Required params: `keyword`, `loadCompositeParents`, `loadVariationParents`, `entriesPerPage`, `pageNumber`, `dataRequirements`, `searchTypes`
- Auth confirmed working (session token valid for eu-ext.linnworks.net)
- Tracks "Days Since OOS" and "First Seen OOS" across runs
- Scheduled weekly Monday 7am UTC

**Files changed**
- `src/cli/linnworks-oos-to-sheets.ts` — history GUID resolution + correct Level field name

---

### 15 July 2026

**Pan-EU Status → Sheets — finally working**
- Root cause found: SP-API `GET_PAN_EU_OFFER_STATUS` report is TSV (not CSV) and has a UTF-8 BOM (`﻿`) on the first character, making the first column key `﻿ASIN` instead of `ASIN` — every `row['ASIN']` lookup returned `undefined`, producing 0 rows
- Added `debug-paneu-raw.ts` diagnostic script + workflow to inspect the raw SP-API report — confirmed TSV format and BOM
- Fixed: strip BOM before parsing, use `parseTsv` instead of `parseCsv`
- Hardcoded 36 current SPINCARE ASINs in `SPINCARE_ASINS` constant (dynamic listings matching was unreliable); update when products change
- Note: report is marketplace-wide (89,201 rows from all EU sellers) — SPINCARE products filtered by hardcoded ASIN list

**AGL delivery date — now static once set**
- `clickup-agl-sync-delivery.ts`: Delivery Date subtask no longer updated if it already has a due date
- Only sets and cascades dates on first time; subsequent runs skip if date already present

**Pan-EU fallback behaviour**
- Fresh report creation frequently stalls `IN_QUEUE` (large report, Amazon queue)
- Script now falls back to most recently completed cached report on any error (not just rate limits)
- Timeout increased to 120 minutes in workflow

**Decisions**
- Hardcoded ASIN list preferred over dynamic listings fetch — listings matching produced 0 rows consistently, cause unclear
- AGL platform has no SP-API role available — using FBA inbound v0 for ETA dates; accept blank ETA until Amazon populates it

**Files changed**
- `src/cli/pan-eu-to-sheets.ts` — BOM strip, parseTsv, hardcoded ASIN list, fallback on any error
- `src/cli/clickup-agl-sync-delivery.ts` — static delivery date once set
- `src/cli/debug-paneu-raw.ts` — NEW diagnostic script
- `.github/workflows/debug-paneu-raw.yml` — NEW debug workflow
- `.github/workflows/pan-eu-to-sheets.yml` — removed FORCE_CACHED, 120m timeout

**Next steps**
- Delete `debug-paneu-raw.ts` and its workflow once confirmed stable
- Dropbox API task — waiting to confirm sales team want it; need folder path and Excel column layout
- Update `SPINCARE_ASINS` in `pan-eu-to-sheets.ts` whenever new products are added
