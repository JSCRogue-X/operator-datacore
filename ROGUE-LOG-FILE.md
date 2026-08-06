# Rogue Log File

Running log of sessions, decisions, and changes made to operator-datacore.

---

## Session Log

### 6 August 2026 (session 2)

**Linn tab rebuilt as a rolling master sheet + two new automations**

- Renamed "Linn 2026" → "Linn" — one continuous tab for all orders 2026 onward, no more yearly copy of Template (Template tab since deleted by Jon)
- Rewrote "Overall" tab formulas for 2026–2032 to pull year-filtered COUNTIFS from Linn instead of hardcoded per-year tab references
- Deleted unused helper columns (Q/R/S) and the cFullName column (not needed) from Linn — layout is now A–G: nOrderId/ChannelReference/dReceievedDate/Country/ProcessedDate/Source/SubSource
- Built `linnworks-weekly-orders-to-linn.ts` — weekly fetch of dispatched + still-open Spin Care/EBAY1 orders from Linnworks, filtered/deduped, appended to Linn; still-open orders get a received+24h placeholder ProcessedDate; a reconciliation pass corrects placeholders to the real dispatch date once known (21-day lookback)
- Fixed "Time Between" column to account for weekends + UK bank holidays + Christmas: new "Bank Holidays" tab + NETWORKDAYS-based formula (replaced an earlier Friday/12:45pm-only hack that broke on same-day Friday dispatches)
- Built `bank-holidays-to-sheets.ts` — pulls the gov.uk bank holidays feed, adds new dates automatically, adds a Christmas Eve entry per year (Ogden-specific closure); idempotent
- Fixed a Dependabot high-severity alert (`brace-expansion`, dev-only) via `npm audit fix`

**Decisions**
- Cron-job.org (not GitHub schedule) for both new automations — weekly orders job already added by Jon; bank holidays job added as **monthly**
- "Time Between" floored at 0 rather than only correcting genuinely-delayed orders — simpler, and negatives were mostly Jon's own old manually copy-pasted weekend placeholder dates anyway (confirmed harmless)
- Bank Holidays list scoped to 2026 onwards (matches Linn tab's data range); currently covers through 2028 since that's as far as gov.uk has published
- `LET()` combined with a cross-sheet NETWORKDAYS reference threw a Sheets formula error for no clear reason — switched to nested `IF` instead of digging further

**Files changed/created**
- `src/cli/linnworks-weekly-orders-to-linn.ts` — new
- `.github/workflows/linnworks-weekly-orders-to-linn.yml` — new, workflow_dispatch only
- `src/cli/debug-linnworks-orders-raw.ts` + `.github/workflows/debug-linnworks-orders-raw.yml` — new, read-only diagnostic, left in repo for future field-name checks
- `src/cli/bank-holidays-to-sheets.ts` — new
- `.github/workflows/bank-holidays-to-sheets.yml` — new, workflow_dispatch only
- `package-lock.json` — brace-expansion bump
- Google Sheet `1LSCRaHwsLBUFAg7DuRAaa8L5wDOfB7upQZ4Hb7-sayo` — Linn tab renamed/restructured, Overall formulas rewritten, new "Bank Holidays" tab, Template tab deleted (not git-tracked, noted here for reference)

**Next steps**
- None critical — both new automations are live and scheduled via Cron-job.org
- Historical Linn rows with old weekend-placeholder ProcessedDate values left as-is (Jon confirmed acceptable)

---

### 6 August 2026

**Disposals — Yearly Data rollup: item cost value added**

- Yearly Data rollup previously wrote only the removal fee (disposal cost) per month
- Updated to include Item Cost Value = FBA UK Landed Cost (Cost tab) × disposed quantity, matching the Dashboard's ARRAYFORMULA exactly
- Dashboard formula uses `VLOOKUP(ASIN, Cost!$H$2:$I, 2, FALSE)` — lookup key is Cost tab **col H** (ASIN), value is col I (FBA UK Landed Cost)
- Three iterations to get the lookup right: first tried SKU/col G, then tried col C ASIN, finally fixed to col H ASIN
- Verified: Jul UK = £225.39, Jul EU = £132.87 — matches Dashboard

**Files changed**
- `src/cli/disposals-to-sheets.ts` — Yearly Data rollup now includes item cost value; cost lookup uses Cost!H:I keyed on ASIN (Disposals Data col E)

**Commits**
- `df2965b` — feat(disposals): include item cost value in Yearly Data rollup
- `42ebfb2` — fix(disposals): fix SKU lookup — try FBA SKU then SKU (superseded)
- `0972e40` — fix(disposals): match Cost tab by ASIN not SKU
- `80caeb3` — fix(disposals): use Cost!H:I for ASIN lookup matching Dashboard formula

**Next steps**
- Run disposals script monthly after Amazon report comes through
- Yearly Data J/K/L will auto-update on every run (idempotent)

---

### 30 July 2026 (session 2)

**AGL Delivery Date Sync — new task added**

- Added "Close SoStocked PO's" to `FROM_DELIVERY` offset table at +4 days (same as Update Unit Pricing (AGL))
- Assigned to Jon Scoulding in ClickUp
- Will cascade automatically whenever a Delivery Date is set on any AGL task

**Files changed**
- `src/cli/clickup-agl-sync-delivery.ts` — added Close SoStocked PO's at +4 days

**Commits**
- `800d352` — feat(agl): add Close SoStocked PO's at Delivery +4 days

---

### 30 July 2026

**ClickUp New Product Launch — gone live**

- Swapped ASSIGNEES table to production user IDs: Will Murphy (32554033), Anthony Taylor (32547067), Laura Haygarth-Borland (93868392), Paul Atkinson (87803456)
- Multi-assignee tasks correctly set: Review Listing, Approve Listing (Anthony + Laura); Complete IH Launch Template (Laura + Will); Re-order eligibility (Anthony + Paul + Laura)
- Inventory - Ship Inventory to Amazon EU confirmed as Paul Atkinson (same as UK)
- Template confirmed: "New Product Template" in R&D space — duplicate and add `new-product` tag to "6. Launch" to activate automation

**AGL Delivery Date Sync — CF 2026-13 US investigation**

- CF 2026-13 US has `cf-agl` tag and correct subtask structure (Delivery Date, Make Final Payment, etc.) — ClickUp side is fine
- Script did not assign dates because it only queries UK + EU Amazon marketplaces — if this is an FBA USA shipment, it needs the North America SP-API endpoint (region: 'na', marketplace ATVPDKIKX0DC)
- Awaiting confirmation from Jon whether CF 2026-13 US is going to Amazon FBA USA

**Decisions**
- Recurring task (Weekly Review Price) will be handled manually in ClickUp — automation feature dropped

**Files changed**
- `src/cli/clickup-new-product-launch.ts` — production ASSIGNEES table

**Commits**
- `2821956` — feat(clickup): swap ASSIGNEES to production user IDs

**Next steps**
- Jon to confirm CF 2026-13 US destination — if FBA USA, add North America SP-API endpoint to AGL sync script

---

### 29 July 2026 (session 2)

**ClickUp New Product Launch — fix sub-subtask recursion (going live tomorrow)**

- Script ran; MISSING log revealed all 10 unmatched tasks are nested sub-subtasks (not direct children of "6. Launch"):
  - 5 PPC tasks — children of "Research/Setup PPC Campaigns"
  - 3 flat file sub tasks — children of "Create flat file template"
  - 2 storefront sub tasks — children of "Add ASIN to storefront"
- Root cause: `applyOffsets` only recursed into `HAS_SUB_SUBTASKS` parents in the "SET dates" path — not in the `isComplete` or `SKIP (dates already set)` branches
- Fix: added `HAS_SUB_SUBTASKS` recursion check to both branches; all 10 tasks will now be found and processed on next run
- Going live 30 July 2026 — Jon to provide live ClickUp space/list and production assignee names tomorrow morning
- Recurring task (Weekly Review Price) will be handled manually in ClickUp — no automation needed

**Decisions**
- Sub-subtask recursion is now consistent across all branches — isComplete, ADD START, SKIP, and SET all recurse when the parent is in `HAS_SUB_SUBTASKS`
- Recurring task feature dropped from to-do — ops team will set recurrence in ClickUp directly

**Files changed**
- `src/cli/clickup-new-product-launch.ts` — recurse into sub-subtask parents from isComplete and SKIP branches

**Commits**
- `ae70f6a` — Fix: recurse into sub-subtask parents even when parent is complete or dates set

**Next steps**
- Tomorrow: Jon to provide live ClickUp space and production assignee names
- Swap `ASSIGNEES` table to production user IDs
- Point automation at live list (if different from current test space)
- Add `new-product` tag to first live job

---

### 29 July 2026

**ClickUp New Product Launch — missing task name logging**

- Script ran at 6:01am via cron-job.org — reported "10 subtask(s) not found"
- Root cause: task names in ClickUp template don't exactly match keys in the offset table
- Fix: updated `applyOffsets` to log each missing task name individually (`MISSING: "task name"`) instead of just a count — next run will show the exact names to fix
- Also noted: Place Purchase Order and Completion Date sections produced nothing — anchor dates not yet set in Section 5 of this job

**Files changed**
- `src/cli/clickup-new-product-launch.ts` — log each missing task name

**Commits**
- `f029975` — fix(clickup): log each missing task name instead of just a count

**Next steps**
- Run script again (or trigger via cron-job.org) to see exact missing task names in GitHub Actions log
- Compare MISSING names against ClickUp template and fix mismatches (either rename tasks in ClickUp or update code keys)
- Set Place Purchase Order and Completion Date anchor dates in Section 5 of the job

---

### 28 July 2026 (session 2)

**ClickUp New Product Launch — assignDays fix + rate limit handling**

- Audited all task offsets against Jon's spreadsheet (columns H = Assign Date, I = Days to Complete, J = Due Date offset)
- Fixed `assignDays` formula: was set to H only; correct formula is H + I (advance notice + working days to complete)
- Updated all 3 offset tables — every task now uses the correct total lead time before due date
- Added `429` rate limit retry to `cuFetch`: reads `Retry-After` header, waits, retries up to 5 times — prevents crash on initial product setup run
- Added missing July 13th and 14th sessions to ROGUE-LOG-FILE.md (log was only going back to July 15th)
- Confirmed twice-daily cron-job.org schedule is safe — rate limits only a risk on first run for a new product; retry logic handles it

**Decisions**
- `assignDays = assignDate (H) + daysToComplete (I)` is the correct formula going forward
- Twice-daily schedule (6am and 1pm) via cron-job.org is fine — routine runs only action a handful of tasks

**Files changed**
- `src/cli/clickup-new-product-launch.ts` — assignDays fix across all 3 offset tables + 429 retry logic

**Commits**
- `0248152` — fix(clickup): correct assignDays to use assign date + days to complete
- `e073903` — fix(clickup): retry on 429 rate limit with Retry-After backoff

**Next steps**
- Remove assignees from initial script (dates only on first run)
- Confirm reopen status with Paul, then build Weekly Review Price recurring task feature
- Swap ASSIGNEES table to production user IDs when ready to go live

---

### 28 July 2026

**Project housekeeping — todo, context, and session summary command**

- Confirmed daily assignment runner: no separate script needed — existing `clickup-new-product-launch.ts` runs daily via cron-job.org and already handles assign-on-start-date logic
- Created `todo.md` in Claude Folder — all open tasks across ClickUp launch script and Pan-EU
- Created `context.md` in Claude Folder — living reference document covering all scripts, sheet IDs, people, schedules, and technical gotchas; to be updated each session
- Created `/session-summary` custom slash command (`.claude/commands/session-summary.md`) — generates timestamped session summary files automatically
- Created `docs/session-summaries/` folder structure in Claude Folder; first summary saved

**Decisions**
- `context.md` and `todo.md` to be read at the start of each session to orient quickly
- `/session-summary` to be run at the end of each session

**Files created**
- `C:\Users\Spincare-JSC\Documents\Claude Folder\todo.md`
- `C:\Users\Spincare-JSC\Documents\Claude Folder\context.md`
- `C:\Users\Spincare-JSC\Documents\Claude Folder\.claude\commands\session-summary.md`
- `C:\Users\Spincare-JSC\Documents\Claude Folder\docs\session-summaries\2026-07-28-1332-session-summary.md`

**Next steps**
- Remove assignees from initial script (dates only on first run)
- Confirm reopen status with Paul, then build Weekly Review Price recurring task feature
- Swap ASSIGNEES table to production user IDs when ready to go live

---

### 27 July 2026 (session 3)

**ClickUp New Product Launch — checklist assignment + delayed assignee plan**

- Fixed checklist assignment: ClickUp does not include `checklists[]` in embedded subtask objects — added individual `GET /task/{id}` fetch after setting dates to get full task data including checklists
- Wired `assignChecklistItems()` into both paths in `applyOffsets`: new-task path and ADD START backfill path — checklist items get the task's start date and same assignee
- Start dates now set for ALL tasks including 0-day tasks: `assignDays=0` tasks get `start_date = due_date` (previously no start date was set for these)
- Removed `assignDays > 0` guard on backfill path — consistent rule: every task always has a start date

**Decisions**
- Tasks with `assignDays=0` get `start_date = due_date` so the daily assignment runner has one consistent signal for all tasks
- Assignees will be removed from the initial script — instead a new daily runner will assign tasks whose start date has arrived (avoids inbox flood when a product is kicked off with 60+ tasks)
- "Weekly Review Price" confirmed as the only recurring task — interval 7 days; awaiting Paul's confirmation of the reopen status before building
- "Negative Keyword Check" is NOT a recurring task (confirmed by Jon)
- ClickUp Automations will not be used for recurring tasks — GitHub Actions cron will handle it instead (scales better across many product launches)

**Files changed**
- `src/cli/clickup-new-product-launch.ts` — all above changes

**Commits**
- `b658dab` — feat: assign checklist items on section 6 launch tasks
- `6e5658b` — fix: fetch full task to get checklists (ClickUp omits checklists from subtask objects)
- `9c893ee` — feat: always set start date, including 0-day tasks

**Next steps**
- Remove assignees from initial script (dates only on first run)
- Build daily GitHub Actions runner: assigns tasks whose start_date <= today and have no assignee yet
- Confirm reopen status with Paul, then build Weekly Review Price recurring task feature
- Swap ASSIGNEES table to production user IDs when ready to go live

---

### 27 July 2026 (session 2)

**ClickUp New Product Launch automation — fully working**

- Fixed tag discovery: tag was on "6. Launch" child task (not the parent) — removed `!t.parent` filter, added `subtasks=true` to tag search, added dedup by task ID (API was returning same task twice)
- Refactored `processNewProductJob` → `processJob(launchSection, parentId)` — handles tag on either parent or launch section directly
- Fixed assignees API format: ClickUp requires `{ add: [...], rem: [] }` not a plain array
- Populated `ASSIGNEES` table with Jon Scoulding (32614246) for all 66 tasks (testing only — will swap to production assignees when live list is ready)
- Added start dates (assign dates) from the spreadsheet: offset tables changed from `Record<string, number>` to `Record<string, [dueOffset, assignDays]>` — start date = due date minus assign days
- New `setDates()` function sets both `start_date` and `due_date` in one API call
- Skip logic: due date + start date locked once set; backfills missing start dates on existing tasks without recalculating due dates
- Completed task detection expanded: catches status type `closed` and `done`, plus status names `complete`, `completed`, `done` (confirmed "COMPLETED" is caught via `type === 'closed'`)

**Decisions**
- Dates are set once and locked — re-running the script on an existing job is safe and idempotent
- `TEST_ASSIGNEE_ID = null` — ASSIGNEES table is now the source of truth (all set to Jon for now)
- `new-product` tag stays on "6. Launch" section task — script handles this directly

**Files changed**
- `src/cli/clickup-new-product-launch.ts` — all above changes

**Commits**
- `a438fb9` — Fix tag discovery + refactor processJob + fix assignees API format
- `4cc6d9a` — Skip tasks that already have a due date set
- `d454795` — Add start dates (assign dates) to all tasks
- `63f83e8` — Skip completed tasks regardless of whether a due date is set

**Next steps**
- Swap ASSIGNEES table to production user IDs (Will Murphy, Anthony Taylor, Laura, Paul Atkinson) when ready to go live
- Place `new-product` tag on real jobs when they are ready to have dates set

---

### 27 July 2026

**Closures**
- PIVOT → Tracking automation confirmed working end-to-end — no further work needed
- Amazon Shipments script — dropped, will not pursue; script already removed from repo (23 Jul)
- Dropbox API task — dropped, will not pursue

**Completed**
- SoStocked account switched to support ✓

---

### 24 July 2026

**PIVOT → Tracking script confirmed working**
- Jon tested `oos-pivot-to-tracking.ts` locally — reads PIVOT rows 4 and 11, finds the current week's row, writes D:L correctly

**Removed commented-out cron from sostocked-to-sheets.yml**
- Workflow is triggered by an external cron job service, not GitHub Actions schedule
- Cleaned up the commented `schedule:` block — `workflow_dispatch` only

**Files changed**
- `.github/workflows/sostocked-to-sheets.yml` — removed commented cron lines

---

### 23 July 2026 (session 2)

**SoStocked CSV parser — multi-line cell fix (last non-empty line)**
- Changed from taking the first line of multi-value CSV cells to the last non-empty line
- Reason: SoStocked puts UK SKU on line 1 and EU-specific SKU on line 2 for EU-B rows; Excel displays the last line — matching that behaviour gives the correct marketplace SKU
- Commit: `e220e15`

**New script: oos-pivot-to-tracking.ts**
- Reads PIVOT!A1:F11: row 4 (A–F) and row 11 (B–C)
- Finds the current week's row in Tracking!B by picking the most recent date ≤ today (weekly tracking tab, not daily — exact match would fail mid-week)
- Writes D:L of that row:
  - D: EU Potential OOS Days (A4), E: EU Last 365 OOS (B4)
  - F: UK Potential OOS Days (C4), G: UK Last 365 OOS (D4)
  - H: Grand Total Potential OOS Days (E4), I: Grand Total Last 365 OOS (F4)
  - J: EU Lost Sales (B11), K: UK Lost Sales (C11)
  - L: Overall Lost Sales = (J × 0.85) + K (EUR → GBP conversion)
- Chained in `sostocked-to-sheets.yml` after a 5-second pause for PIVOT formulas to recalculate
- Script not yet live-tested — Jon to run manually first (next Monday will be the real run)

**Decisions**
- Weekly date matching: use most recent date ≤ today rather than exact match — workflow runs on Mondays so will be exact in production, but mid-week testing still works
- EUR → GBP rate hardcoded at 0.85 in the script

**Files created/changed**
- `src/cli/oos-pivot-to-tracking.ts` — new script
- `.github/workflows/sostocked-to-sheets.yml` — added 5s wait + PIVOT→Tracking step after SoStocked step

---

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

**Note**
- `--year`/`--month` CLI args added to `linnworks-30-day-sales-to-sheets.ts` — completed

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

---

### 14 July 2026

**Pan-EU Status → Sheets — extended debugging session**

- Diagnosed why Pan-EU script produced 0 rows — extensive column name debugging, switched from SKU to ASIN matching
- Added diagnostic logging to isolate column name issues
- Switched from CSV parsing to TSV (report format confirmed as TSV on this date; BOM root cause found next day)
- Fixed Pan-EU workflow — added missing Supabase env vars
- Increased job timeout: 30 min → 60 min → 120 minutes (report generation slow in Amazon queue)
- Implemented cached report fallback — falls back to most recently completed report if fresh generation fails
- Added `FORCE_CACHED` flag to workflow for testing purposes (later removed)
- AGL delivery sync: fixed shipment name normalisation for matching; `clickup-agl-sync-delivery.ts` updated
- Account Health: set to overwrite on every run rather than append

**Files changed**
- `src/cli/pan-eu-to-sheets.ts` — diagnostic logging, ASIN matching, TSV switch, caching fallback
- `src/cli/clickup-agl-sync-delivery.ts` — shipment name normalisation
- `.github/workflows/pan-eu-to-sheets.yml` — timeout increases, Supabase env vars, cached flag

---

### 13 July 2026

**Pan-EU Status → Sheets — initial build**

- Built initial `pan-eu-to-sheets.ts` script — pulls `GET_PAN_EU_OFFER_STATUS` report from SP-API and writes to Automations sheet
- Added `pan-eu-to-sheets.yml` daily workflow
- Fixed Listing / No Listing logic for Pan-EU offer columns (two rounds of fixes)

**FBA Customer Returns → Automations sheet**

- Built `returns-to-sheets.ts` — pulls FBA Customer Returns report monthly and writes to Automations sheet
- Added `returns-to-sheets.yml` workflow — no schedule; triggered externally via cron-job.org
- Updated column headers to match Jon's spec

**Other changes**

- Moved Account Health to its own separate workflow (`account-health-to-sheets.yml`) running Fridays 2pm UTC — previously bundled in weekly-sheets
- Fixed missing Supabase env vars in `replen-to-sheets` workflow

**Files created/changed**
- `src/cli/pan-eu-to-sheets.ts` — new script
- `.github/workflows/pan-eu-to-sheets.yml` — new workflow
- `src/cli/returns-to-sheets.ts` — new script
- `.github/workflows/returns-to-sheets.yml` — new workflow (cron-job.org triggered)
- `.github/workflows/account-health-to-sheets.yml` — new standalone workflow
- `.github/workflows/replen-to-sheets.yml` — Supabase env vars fix
