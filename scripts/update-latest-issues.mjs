// Pulls the latest published issues from the beehiiv API and rewrites the
// "Latest issues" cards in index.html (between the LATEST-ISSUES markers).
// Run by .github/workflows/latest-issues.yml on a schedule. Needs the
// BEEHIIV_API_KEY secret; BEEHIIV_PUBLICATION_ID is optional (auto-discovered).

import { readFile, writeFile } from "node:fs/promises";

const API = "https://api.beehiiv.com/v2";
const KEY = process.env.BEEHIIV_API_KEY;
const LIMIT = 3;
const FILE = "index.html";
const START = "<!-- LATEST-ISSUES:START -->";
const END = "<!-- LATEST-ISSUES:END -->";

if (!KEY) {
  console.log("BEEHIIV_API_KEY not set - skipping (add it as a repo secret to enable).");
  process.exit(0);
}

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getPublicationId() {
  if (process.env.BEEHIIV_PUBLICATION_ID) return process.env.BEEHIIV_PUBLICATION_ID;
  const j = await getJson(`${API}/publications`);
  const id = j.data?.[0]?.id;
  if (!id) throw new Error("No publications returned for this API key.");
  console.log(`Auto-discovered publication: ${id}`);
  return id;
}

const pubId = await getPublicationId();
const url =
  `${API}/publications/${pubId}/posts` +
  `?status=confirmed&limit=${LIMIT}&order_by=publish_date&direction=desc`;
const { data } = await getJson(url);

if (!Array.isArray(data) || data.length === 0) {
  console.log("No published posts returned - leaving index.html unchanged.");
  process.exit(0);
}

const cards = data
  .map((p) => {
    const href = p.web_url || `https://your-ai-controller.beehiiv.com/p/${p.slug}`;
    const date = fmtDate(p.publish_date || p.displayed_date);
    const title = esc(p.title);
    const sub = p.subtitle ? `\n        <p>${esc(p.subtitle)}</p>` : "";
    return (
      `      <a class="issue" href="${esc(href)}" target="_blank" rel="noopener">\n` +
      `        <span class="date">${esc(date)}</span>\n` +
      `        <h3>${title}</h3>${sub}\n` +
      `        <span class="read">Read the issue →</span>\n` +
      `      </a>`
    );
  })
  .join("\n");

const html = await readFile(FILE, "utf8");
const s = html.indexOf(START);
const e = html.indexOf(END);
if (s === -1 || e === -1) throw new Error("LATEST-ISSUES markers not found in index.html");

const next = html.slice(0, s + START.length) + "\n" + cards + "\n      " + html.slice(e);
if (next === html) {
  console.log("Latest issues already up to date - no change.");
  process.exit(0);
}

await writeFile(FILE, next, "utf8");
console.log(`Updated index.html with ${data.length} latest issue(s).`);
