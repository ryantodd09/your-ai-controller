// Regenerates the "Recent regulatory activity" feed on /instruction-tracker/
// from the Federal Register, covering ALL tracked reports. Writes between the
// ACTIVITY markers in instruction-tracker/index.html.
//
// Attribution guard: the Federal Register full-text search matches a report's
// identifier anywhere in a document (including footnotes), which over-matches.
// So we only attribute an item to a report when that report's identifier also
// appears in the TITLE or ABSTRACT - tight, defensible attribution for a public
// page. Relevance is limited to rules, proposed rules, and PRA information-
// collection notices (the signals that precede an instruction change).
//
// Run: node scripts/gen-activity-feed.mjs   (also runs in CI on a schedule)

import { readFile, writeFile } from "node:fs/promises";

const FILE = "instruction-tracker/index.html";
const START = "<!-- ACTIVITY:START -->";
const END = "<!-- ACTIVITY:END -->";
const API = "https://www.federalregister.gov/api/v1/documents.json";
const SINCE = "2024-06-01";   // lookback window for the public feed
const MAX_ITEMS = 9;
const PROCESS = 20;           // newest candidates to attribute (bounds full-text fetches)

// Every tracked report, with the exact-phrase terms used to find its activity
// and the issuing agency (for the API filter + display).
const REPORTS = [
  { label: "Call Report (FFIEC 031/041)", terms: ["FFIEC 031", "FFIEC 041"], agencies: [] },
  { label: "FR Y-9C", terms: ["FR Y-9C"], agencies: ["federal-reserve-system"] },
  { label: "FR Y-14", terms: ["FR Y-14"], agencies: ["federal-reserve-system"] },
  { label: "FR Y-15", terms: ["FR Y-15"], agencies: ["federal-reserve-system"] },
  { label: "FFIEC 009", terms: ["FFIEC 009"], agencies: [] },
  { label: "FFIEC 101", terms: ["FFIEC 101"], agencies: [] },
  { label: "FR 2052a", terms: ["FR 2052a"], agencies: ["federal-reserve-system"] },
  { label: "FR 2510", terms: ["FR 2510"], agencies: ["federal-reserve-system"] },
  { label: "FR 2590", terms: ["FR 2590"], agencies: ["federal-reserve-system"] },
  { label: "TIC B Forms", terms: ["TIC BC", "TIC BL", "TIC BQ"], agencies: ["treasury-department"] },
  { label: "TIC SLT", terms: ["TIC SLT"], agencies: ["treasury-department"] },
  { label: "TIC SHC/SHCA", terms: ["TIC SHC", "TIC SHCA"], agencies: ["treasury-department"] },
  { label: "TIC SHL/SHLA", terms: ["TIC SHL", "TIC SHLA"], agencies: ["treasury-department"] },
  { label: "TIC Form D", terms: ["TIC Form D"], agencies: ["treasury-department"] },
  { label: "TIC TFC", terms: ["TFC-1", "Treasury Foreign Currency"], agencies: ["treasury-department"] },
];

const TYPES = ["RULE", "PRORULE", "NOTICE"];
const PRA_RE = /information collection|proposed collection|omb review|comment request|paperwork reduction|renewal/i;
const FIELDS = ["document_number", "title", "type", "publication_date", "html_url", "abstract", "raw_text_url"];

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function clip(s, n) { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function typeLabel(t) { return t === "Proposed Rule" ? "Proposed Rule" : t === "Rule" ? "Rule" : "PRA Notice"; }

async function queryTerm(term, agencies) {
  const p = new URLSearchParams();
  p.set("conditions[term]", `"${term}"`);
  p.set("conditions[publication_date][gte]", SINCE);
  p.set("per_page", "30");
  p.set("order", "newest");
  for (const t of TYPES) p.append("conditions[type][]", t);
  for (const a of agencies) p.append("conditions[agencies][]", a);
  for (const f of FIELDS) p.append("fields[]", f);
  const res = await fetch(`${API}?${p}`, { headers: { "User-Agent": "yac-activity-feed/1.0" } });
  if (!res.ok) throw new Error(`FR ${res.status} for "${term}"`);
  return (await res.json()).results || [];
}

function isRelevant(doc) {
  const t = (doc.type || "").toLowerCase();
  return t === "rule" || t === "proposed rule" || PRA_RE.test(doc.title || "");
}

async function fetchText(url) {
  if (!url) return "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "yac-activity-feed/1.0" } });
    return res.ok ? await res.text() : "";
  } catch { return ""; }
}

// Which reports does this document actually concern? Check the FULL TEXT, for
// both notices and rules: the banking-agency PRA notices AND the major capital
// rules name the affected reports (FFIEC 031, FR Y-9C, FFIEC 101, ...) in the
// body, never the short abstract. Falls back to title+abstract if the body
// can't be fetched. A report is attributed when its identifier appears.
function occurrences(hay, term) { return hay.split(term).length - 1; }
function attribute(doc, fullText) {
  const usingFull = !!(fullText && fullText.length);
  const hay = (usingFull ? fullText : `${doc.title || ""} ${doc.abstract || ""}`).toLowerCase();
  // Long rules mention a report once in passing; a genuine reporting rule names
  // it repeatedly. Require >=2 hits for rules read from full text; PRA notices
  // are short and deliberate, so >=1 is enough.
  const isRule = /rule/.test((doc.type || "").toLowerCase());
  const min = usingFull && isRule ? 2 : 1;
  return REPORTS.filter((r) => r.terms.some((t) => occurrences(hay, t.toLowerCase()) >= min)).map((r) => r.label);
}

// 1. gather unique relevant candidates across all reports
const cand = new Map();   // document_number -> doc
for (const rep of REPORTS) {
  for (const term of rep.terms) {
    let results;
    try { results = await queryTerm(term, rep.agencies); }
    catch (e) { console.error(`  ! ${e.message}`); continue; }
    for (const doc of results) if (isRelevant(doc)) cand.set(doc.document_number, doc);
  }
}

// 2. newest first, then attribute the top slice (full-text fetch only for notices)
const ordered = [...cand.values()].sort((a, b) => (a.publication_date < b.publication_date ? 1 : -1)).slice(0, PROCESS);
const items = [];
for (const doc of ordered) {
  const full = await fetchText(doc.raw_text_url);
  const reports = attribute(doc, full);
  if (reports.length) items.push({ doc, reports });
  if (items.length >= MAX_ITEMS) break;
}

if (items.length === 0) { console.log("No relevant activity found - leaving page unchanged."); process.exit(0); }

const html = items.map(({ doc, reports }) => {
  const affects = reports.length > 4 ? reports.slice(0, 4).join(", ") + `, +${reports.length - 4} more` : reports.join(", ");
  return (
    `      <div class="item">\n` +
    `        <div class="date">${esc(fmtDate(doc.publication_date))}</div>\n` +
    `        <div class="body">\n` +
    `          <h3>${esc(clip(doc.title, 96))}<span class="pill">${esc(typeLabel(doc.type))}</span></h3>\n` +
    `          <div class="meta">Affects ${esc(affects)}</div>\n` +
    `          <p>${esc(clip(doc.abstract, 200))}</p>\n` +
    `          <a class="src" href="${esc(doc.html_url)}" target="_blank" rel="noopener">Federal Register ↗</a>\n` +
    `        </div>\n` +
    `      </div>`
  );
}).join("\n");

const page = await readFile(FILE, "utf8");
const s = page.indexOf(START), e = page.indexOf(END);
if (s === -1 || e === -1) throw new Error("ACTIVITY markers not found in " + FILE);
const next = page.slice(0, s + START.length) + "\n" + html + "\n      " + page.slice(e);
if (next === page) { console.log("Activity feed already up to date."); process.exit(0); }
await writeFile(FILE, next, "utf8");
const reportsCovered = new Set(items.flatMap((i) => i.reports)).size;
console.log(`Updated activity feed: ${items.length} item(s) across ${reportsCovered} report(s).`);
