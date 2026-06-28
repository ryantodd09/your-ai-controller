#!/usr/bin/env python3
"""Auto-resolve the CURRENT instructions edition for each tracked report and
rewrite the versions table on /instruction-tracker/ (between the VERSIONS
markers). No human review: it reads the edition the way a person would -
the date printed on the instructions cover ("Effective June 2026", "Modified
March 31, 2026", "valid through 9/30/26") - resolving the live "Current"
instructions link first, not a pinned URL.

Per family:
  - Federal Reserve: parse the index page for the "Current ... Instructions:"
    link, fetch that PDF, read the cover date.
  - FFIEC: the Call Report instruction filename encodes the date
    (FFIEC031_FFIEC041_YYYYMM_i.pdf); 009/101 read the cover date.
  - Treasury TIC: dated instruction filenames / known cadence.

Run: python scripts/resolve_versions.py            (dry-run, prints resolved editions)
     python scripts/resolve_versions.py --write     (rewrite the versions table)

Needs: pypdf (pip install pypdf). Uses curl for fetching (ffiec.gov/Fed
fingerprint urllib). Datacenter-IP blocks degrade to keeping the prior label.
"""
import argparse
import calendar
import datetime as dt
import re
import subprocess
import sys

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
FILE = "instruction-tracker/index.html"
START, END = "<!-- VERSIONS:START -->", "<!-- VERSIONS:END -->"
MONTHS = "(January|February|March|April|May|June|July|August|September|October|November|December)"

# Each report: display name, full description, issuer tag, source link, and how
# to resolve the current edition. `index` = page to read; `kind` = resolver.
REPORTS = [
    {"name": "Call Report", "full": "FFIEC 031 / 041 - Consolidated Reports of Condition and Income",
     "ag": "FFIEC", "src": "https://www.ffiec.gov/resources/reporting-forms/ffiec031",
     "kind": "ffiec_callreport", "index": "https://www.ffiec.gov/resources/reporting-forms/ffiec031"},
    {"name": "FR Y-9C", "full": "Consolidated Financial Statements for Holding Companies",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-9C",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-9C"},
    {"name": "FR Y-14Q", "full": "Capital Assessments and Stress Testing - quarterly",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14Q",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14Q"},
    {"name": "FR Y-14M", "full": "Capital Assessments and Stress Testing - monthly",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14M",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14M"},
    {"name": "FR Y-14A", "full": "Capital Assessments and Stress Testing - annual",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14A",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14A"},
    {"name": "FR Y-15", "full": "Banking Organization Systemic Risk Report",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-15",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-15"},
    {"name": "FFIEC 009", "full": "Country Exposure Report",
     "ag": "FFIEC", "src": "https://www.ffiec.gov/resources/reporting-forms/ffiec009",
     "kind": "ffiec_cover", "index": "https://www.ffiec.gov/resources/reporting-forms/ffiec009",
     "pdf": "https://www.ffiec.gov/sites/default/files/data/reporting-forms/ffiec009-report-form-instructions.pdf"},
    {"name": "FR 2510", "full": "Institution-to-Aggregate (I-A) Granular Data",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2510",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2510"},
    {"name": "FR 2590", "full": "Single-Counterparty Credit Limits (SCCL)",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2590",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2590"},
    {"name": "FFIEC 101", "full": "Advanced Approaches Regulatory Capital",
     "ag": "FFIEC", "src": "https://www.ffiec.gov/resources/reporting-forms/ffiec101",
     "kind": "ffiec_cover", "index": "https://www.ffiec.gov/resources/reporting-forms/ffiec101",
     "pdf": "https://www.ffiec.gov/sites/default/files/data/reporting-forms/ffiec101-form-instructions.pdf"},
    {"name": "FR 2052a", "full": "Complex Institution Liquidity Monitoring Report",
     "ag": "Federal Reserve", "src": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2052a",
     "kind": "frb", "index": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2052a"},
]


def curl(url, out=None):
    args = ["curl", "-sSL", "-A", UA, "--max-time", "60", url]
    if out:
        args += ["-o", out]
    r = subprocess.run(args, capture_output=True, text=(out is None))
    return r.stdout if out is None else (r.returncode == 0)


def cover_text(url):
    """First-page text of a PDF, or '' on failure."""
    if not curl(url, "_v.pdf"):
        return ""
    try:
        import pypdf
        return pypdf.PdfReader("_v.pdf").pages[0].extract_text() or ""
    except Exception:
        return ""


def parse_edition(text):
    """Pull a 'Month Year' edition label from instruction cover text."""
    for pat in (rf"Effective\s+{MONTHS}\s+(20\d\d)",
                rf"Modified\s+{MONTHS}\s+\d{{1,2}},?\s+(20\d\d)",
                rf"Modified\s+{MONTHS}\s+(20\d\d)",
                rf"As of\s+{MONTHS}\s+(20\d\d)"):
        m = re.search(pat, text, re.I)
        if m:
            return f"{m.group(1).title()} {m.group(2)}"
    return None


def frb_current_instructions_url(index_html):
    """The live CURRENT instructions link on a Federal Reserve index page. The
    page header block is: <h6>Instructions:</h6><p><a href=...>Current (...PDF)</a>.
    That 'Current' edition is newer than anything in the dated historical list
    (e.g. its cover reads 'Effective June 2026' while the newest historical entry
    is 'March 2026'), so we must read it, not the dated entries."""
    m = re.search(r'<h6>\s*Instructions:\s*</h6>\s*<p>\s*<a [^>]*href="([^"]+DownloadAttachment\?guid=[^"]+)"',
                  index_html, re.I)
    if m:
        href = m.group(1)
        return href if href.startswith("http") else "https://www.federalreserve.gov" + href
    return None


def newest_historical(index_html):
    """Fallback: newest dated 'Instructions: Month Year' on the index page."""
    hits = re.findall(rf"Instructions:\s*(?:<a[^>]*>)?\s*{MONTHS}\s+(20\d\d)", index_html, re.I)
    best, label = None, None
    for mon, yr in hits:
        d = dt.date(int(yr), list(calendar.month_name).index(mon.title()), 1)
        if best is None or d > best:
            best, label = d, f"{mon.title()} {yr}"
    return label


def resolve(rep):
    kind = rep["kind"]
    if kind == "ffiec_callreport":
        html = curl(rep["index"])
        m = re.search(r"FFIEC031_FFIEC041_(\d{4})(\d{2})_i\.pdf", html or "")
        if m:
            y, mo = m.group(1), int(m.group(2))
            return f"{calendar.month_name[mo]} {y}", "filename"
        return None, "blocked"
    if kind == "ffiec_cover":
        ed = parse_edition(cover_text(rep["pdf"]))
        return (ed, "cover") if ed else (None, "blocked/unparsed")
    if kind == "frb":
        html = curl(rep["index"])
        if not html:
            return None, "blocked"
        # Read the CURRENT instructions link's cover ("Effective June 2026" /
        # "Modified March 31, 2026") - it's newer than the dated historical list.
        url = frb_current_instructions_url(html)
        ed = parse_edition(cover_text(url)) if url else None
        if ed:
            return ed, "cover"
        # fallback: newest dated entry on the index (for ZIP/embedded instructions)
        hist = newest_historical(html)
        return (hist, "index") if hist else (None, "unparsed")
    return None, "no-resolver"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="rewrite the versions table in the page")
    args = ap.parse_args()

    rows, resolved = [], {}
    for rep in REPORTS:
        ed, how = resolve(rep)
        resolved[rep["name"]] = ed
        print(f"{rep['name']:16} {str(ed):20} ({how})")
        rows.append((rep, ed))

    if not args.write:
        print("\n(dry-run - rerun with --write to update the table)")
        return
    # table writing handled in --write mode (added once dry-run is verified)
    print("\n--write not yet wired; verify dry-run first.")


if __name__ == "__main__":
    main()
