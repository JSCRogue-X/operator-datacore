# Rogue Log File

Running log of sessions, decisions, and changes made to operator-datacore.

---

## Session Log

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
