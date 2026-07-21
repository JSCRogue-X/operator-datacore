"""
Linnworks Out-of-Stock Days Analyser
Pulls stock change history and calculates days OOS per SKU, broken down by year.
Output: Google Sheets — writes Summary and Detail sections to the "Output" tab.

Usage:
    Set credentials in .env file or as environment variables, then run:
    python linnworks_oos.py

Required env vars:
    LINNWORKS_APP_ID
    LINNWORKS_APP_SECRET
    LINNWORKS_TOKEN
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE  (optional — defaults to key file path below)
"""

import os
import re
import sys
import time
from datetime import date, datetime, timezone

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build

def load_dotenv(path=".env"):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_dotenv()

APP_ID     = os.environ.get("LINNWORKS_APP_ID", "")
APP_SECRET = os.environ.get("LINNWORKS_APP_SECRET", "")
TOKEN      = os.environ.get("LINNWORKS_TOKEN") or os.environ.get("LINNWORKS_INSTALL_TOKEN", "")

KEY_FILE = os.environ.get(
    "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
    r"C:\Users\Spincare-JSC\Documents\Claude Folder\spincare-sheets-key.json",
)

SPREADSHEET_ID = "1sF1lxqJMKJQpnsK3q6e7zzcDSucBDUsl0CHfwkocqcQ"
TAB_NAME       = "Output"

# SKUs to exclude until a given date (add more as needed)
EXCLUDE_UNTIL = {
    "RCM-DRYING-RACK": date(2027, 1, 1),
}

if not all([APP_ID, APP_SECRET, TOKEN]):
    sys.exit(
        "ERROR: Missing Linnworks credentials.\n"
        "Set LINNWORKS_APP_ID, LINNWORKS_APP_SECRET, and LINNWORKS_INSTALL_TOKEN\n"
        "(or LINNWORKS_TOKEN) as environment variables or in a .env file.\n"
    )

if not os.path.exists(KEY_FILE):
    sys.exit(
        f"ERROR: Google service account key not found at:\n  {KEY_FILE}\n"
        "Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE env var to the correct path.\n"
    )

TODAY          = date.today()
ANALYSIS_START = date(TODAY.year - 3, TODAY.month, TODAY.day)
YEARS          = sorted({ANALYSIS_START.year, ANALYSIS_START.year + 1,
                         ANALYSIS_START.year + 2, TODAY.year})

print(f"Analysis window: {ANALYSIS_START} → {TODAY}")
print(f"Year columns: {YEARS}")

# ── Date parsing ─────────────────────────────────────────────────────────────

def parse_date(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date()
    s = str(value)
    m = re.match(r"/Date\((-?\d+)([+-]\d+)?\)/", s)
    if m:
        return datetime.fromtimestamp(int(m.group(1)) / 1000, tz=timezone.utc).date()
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ",
                "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:len(fmt) + 4], fmt).date()
        except ValueError:
            pass
    try:
        from dateutil import parser as dp
        return dp.parse(s).date()
    except Exception:
        return None

def days_overlap(start, end, year):
    y_start = date(year, 1, 1)
    y_end   = date(year, 12, 31)
    lo = max(start, y_start)
    hi = min(end,   y_end)
    return max(0, (hi - lo).days)

def effective_days_in_year(year, analysis_start, today):
    """Days within the analysis window that fall in the given year."""
    y_start = date(year, 1, 1)
    y_end   = date(year, 12, 31)
    lo = max(analysis_start, y_start)
    hi = min(today, y_end)
    return max(0, (hi - lo).days)

# ── Linnworks client ──────────────────────────────────────────────────────────

class LinnworksClient:
    AUTH_URL = "https://api.linnworks.net"

    def __init__(self, app_id, app_secret, token):
        self.session = requests.Session()
        self._auth(app_id, app_secret, token)

    def _auth(self, app_id, app_secret, token):
        resp = self.session.post(
            f"{self.AUTH_URL}/api/Auth/AuthorizeByApplication",
            json={"ApplicationId": app_id, "ApplicationSecret": app_secret, "Token": token},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self.access_token = data["Token"]
        self.server       = data["Server"].rstrip("/")
        self.session.headers.update({"Authorization": self.access_token})
        print(f"Authenticated. Server: {self.server}")

    def _request(self, method, path, params=None, body=None, retries=3):
        url = f"{self.server}{path}"
        for attempt in range(retries):
            try:
                if method == "GET":
                    resp = self.session.get(url, params=params, timeout=60)
                else:
                    resp = self.session.post(url, json=body or {}, timeout=60)
                if resp.status_code == 429:
                    wait = int(resp.headers.get("Retry-After", 5))
                    print(f"  Rate limited — waiting {wait}s")
                    time.sleep(wait)
                    continue
                if not resp.ok:
                    print(f"  HTTP {resp.status_code} {path}", flush=True)
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException:
                if attempt == retries - 1:
                    raise
                time.sleep(2 ** attempt)

    def _get(self, path, params=None, retries=3):
        return self._request("GET", path, params=params, retries=retries)

    def _post(self, path, body=None, retries=3):
        return self._request("POST", path, body=body, retries=retries)

    def get_locations(self):
        data = self._get("/api/Inventory/GetStockLocations")
        if isinstance(data, list):
            return data
        return data.get("Data", []) if isinstance(data, dict) else []

    def get_all_stock_items(self):
        items, page = [], 1
        while True:
            data = self._post("/api/Stock/GetStockItemsFull", {
                "keyword":              "",
                "loadCompositeParents": False,
                "loadVariationParents": False,
                "entriesPerPage":       200,
                "pageNumber":           page,
                "dataRequirements":     [],
                "searchTypes":          ["SKU", "Title", "Barcode"],
            })
            if isinstance(data, list):
                items.extend(data)
                print(f"  Stock items: {len(items)} total")
                break
            batch = data.get("Items", data.get("Data", []))
            items.extend(batch)
            total_pages = data.get("TotalPages", 1)
            print(f"  Stock items page {page}/{total_pages} ({len(items)} so far)")
            if page >= total_pages:
                break
            page += 1
            time.sleep(0.15)
        return items

    def get_stock_history(self, stock_item_id, location_id=None):
        all_entries, page = [], 1
        while True:
            params = {
                "stockItemId":    stock_item_id,
                "pageNumber":     page,
                "entriesPerPage": 500,
            }
            if location_id:
                params["locationId"] = location_id
            data = self._get("/api/Stock/GetItemChangesHistory", params)
            if isinstance(data, list):
                all_entries.extend(data)
                break
            entries     = data.get("Data", [])
            total_pages = data.get("TotalPages", 1)
            all_entries.extend(entries)
            if page >= total_pages:
                break
            page += 1
            time.sleep(0.1)
        return all_entries

# ── OOS calculation ───────────────────────────────────────────────────────────

def find_first_sale_date(history):
    """Return the earliest date with a negative ChangeQty (first sale/dispatch)."""
    dates = []
    for e in history:
        try:
            change_qty = int(e.get("ChangeQty") or 0)
        except (ValueError, TypeError):
            continue
        if change_qty < 0:
            d = parse_date(e.get("Date"))
            if d is not None:
                dates.append(d)
    return min(dates) if dates else None


def calculate_oos_periods(history, analysis_start, today, first_sale_date=None):
    # Never sold — return empty (0 OOS days)
    if first_sale_date is None:
        return []

    # Only count OOS from when the item first sold
    effective_start = max(analysis_start, first_sale_date)
    if effective_start > today:
        return []

    if not history:
        return []

    parsed = []
    for e in history:
        d = parse_date(e.get("Date"))
        if d is not None:
            parsed.append((d, int(e.get("Level", 0))))
    if not parsed:
        return []
    parsed.sort(key=lambda x: x[0])

    pre = [level for (d, level) in parsed if d < effective_start]
    current_level = pre[-1] if pre else 1

    oos_start   = effective_start if current_level == 0 else None
    oos_periods = []

    for entry_date, level in parsed:
        if entry_date < effective_start:
            continue
        if entry_date > today:
            break
        if level == 0 and oos_start is None:
            oos_start = entry_date
        elif level > 0 and oos_start is not None:
            oos_periods.append((oos_start, entry_date))
            oos_start = None

    if oos_start is not None:
        oos_periods.append((oos_start, today))

    return oos_periods

# ── Google Sheets write ───────────────────────────────────────────────────────

def write_to_sheets(summary_rows, detail_rows, instock_pct):
    creds = service_account.Credentials.from_service_account_file(
        KEY_FILE,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    sheets  = service.spreadsheets()

    summary_headers = ["SKU", "Title", "Total OOS Days"] + [str(y) for y in YEARS]
    detail_headers  = ["SKU", "Title", "OOS From", "OOS To", "Days OOS"]
    # Write percentages as plain numbers (0–100) so Sheets stores them as real values
    instock_row = ["In-stock %", "", ""] + [round(instock_pct.get(y, 0), 1) for y in YEARS]

    all_rows = (
        [
            [f"OOS Summary — run {TODAY.isoformat()}  |  window: {ANALYSIS_START} → {TODAY}"],
            instock_row,
            summary_headers,
        ]
        + [[str(v) if not isinstance(v, (int, float)) else v for v in r] for r in summary_rows]
        + [[]]
        + [["OOS Detail"]]
        + [detail_headers]
        + [[str(v) if not isinstance(v, (int, float)) else v for v in r] for r in detail_rows]
    )

    # Get the Output tab's sheet ID for formatting
    meta = sheets.get(
        spreadsheetId=SPREADSHEET_ID,
        fields="sheets.properties",
    ).execute()
    sheet_id = next(
        s["properties"]["sheetId"]
        for s in meta["sheets"]
        if s["properties"]["title"] == TAB_NAME
    )

    sheets.values().clear(
        spreadsheetId=SPREADSHEET_ID,
        range=TAB_NAME,
    ).execute()

    sheets.values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=f"{TAB_NAME}!A1",
        valueInputOption="RAW",
        body={"values": all_rows},
    ).execute()

    # Bold rows 2 (in-stock %) and 3 (column headers)
    sheets.batchUpdate(
        spreadsheetId=SPREADSHEET_ID,
        body={
            "requests": [
                {
                    "repeatCell": {
                        "range": {
                            "sheetId":       sheet_id,
                            "startRowIndex": 1,
                            "endRowIndex":   3,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "textFormat": {"bold": True},
                            }
                        },
                        "fields": "userEnteredFormat.textFormat.bold",
                    }
                }
            ]
        },
    ).execute()

    total_rows = len(all_rows)
    print(f"  Written {total_rows} rows to '{TAB_NAME}' tab.")
    print(f"  View: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    client = LinnworksClient(APP_ID, APP_SECRET, TOKEN)

    # ── Fetch Ogden Fulfilment location ID ────────────────────────────────────
    NULL_GUID = "00000000-0000-0000-0000-000000000000"
    raw_locs  = client.get_locations()
    ogden_location_id = None
    for loc in raw_locs:
        loc_id   = loc.get("StockLocationId") or loc.get("Id") or ""
        loc_name = loc.get("LocationName") or loc.get("Name") or ""
        if "ogden" in loc_name.lower() and loc_id.lower() != NULL_GUID:
            ogden_location_id = loc_id
            print(f"  Using location: {loc_name} → {loc_id}", flush=True)
            break
    if not ogden_location_id:
        print("  WARNING: Ogden Fulfilment location not found — history calls may fail", flush=True)
    # ──────────────────────────────────────────────────────────────────────────

    print("\nFetching all stock items...")
    all_items = client.get_all_stock_items()

    # Filter to SPINCARE category only
    items = [i for i in all_items if (i.get("CategoryName") or "") == "SPINCARE"]
    print(f"Total: {len(all_items)} items fetched, {len(items)} in SPINCARE category\n")

    summary_rows = []
    detail_rows  = []

    for i, item in enumerate(items):
        sku     = item.get("ItemNumber") or item.get("SKU") or ""
        title   = item.get("ItemTitle") or item.get("Title") or ""
        item_id = item.get("StockItemId") or item.get("Id") or ""
        if not item_id:
            continue

        if TODAY < EXCLUDE_UNTIL.get(sku, date.min):
            continue

        if (i + 1) % 25 == 0 or i == 0:
            print(f"  Processing {i + 1}/{len(items)}: {sku}")

        try:
            history = client.get_stock_history(item_id, location_id=ogden_location_id)
        except Exception as e:
            if (i + 1) <= 5:
                print(f"  WARN [{i+1}]: {sku or item_id}: {e}", flush=True)
            history = []

        first_sale_date = find_first_sale_date(history)
        oos_periods     = calculate_oos_periods(history, ANALYSIS_START, TODAY, first_sale_date)
        total_days      = sum((end - start).days for start, end in oos_periods)
        year_days       = {y: sum(days_overlap(s, e, y) for s, e in oos_periods) for y in YEARS}

        summary_rows.append([sku, title, total_days] + [year_days[y] for y in YEARS])
        for s, e in oos_periods:
            detail_rows.append([sku, title, s.isoformat(), e.isoformat(), (e - s).days])

        time.sleep(0.2)

    # ── Calculate in-stock % per year ─────────────────────────────────────────
    n = len(summary_rows)
    instock_pct = {}
    for idx, y in enumerate(YEARS):
        avail = effective_days_in_year(y, ANALYSIS_START, TODAY)
        if avail > 0 and n > 0:
            total_oos = sum(row[3 + idx] for row in summary_rows)
            instock_pct[y] = max(0.0, min(100.0, (1 - total_oos / (avail * n)) * 100))
        else:
            instock_pct[y] = 100.0
    # ──────────────────────────────────────────────────────────────────────────

    print(f"\n{len(summary_rows)} SKUs analysed, {len(detail_rows)} OOS periods found.")
    for idx, y in enumerate(YEARS):
        avail = effective_days_in_year(y, ANALYSIS_START, TODAY)
        print(f"  {y}: {avail} days in window, in-stock {instock_pct[y]:.1f}%")
    print("Writing to Google Sheets...")
    write_to_sheets(summary_rows, detail_rows, instock_pct)
    print("Done!")

if __name__ == "__main__":
    main()
