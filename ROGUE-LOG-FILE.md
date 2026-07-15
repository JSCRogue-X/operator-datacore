# Rogue Log File

Running log of sessions, decisions, and changes made to operator-datacore.

---

## Session Log

### 15 July 2026 (continued)

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
