// Fetch CSL-JSON parents from a Zotero group collection, read pinned keys from
// "Extra" (CSL 'note'), fetch server BibTeX for the same items, and rewrite keys.
// Writes extra/references.bib

import fs from "node:fs/promises";
import path from "node:path";

const API_KEY = process.env.API_KEY || process.env.INPUT_API_KEY;
const IS_GROUP = process.env.IS_GROUP || process.env.INPUT_IS_GROUP || "false";
const LIBRARY_ID = process.env.LIBRARY_ID || process.env.INPUT_LIBRARY_ID;
const COLL_KEY = process.env.COLL_KEY || process.env.INPUT_COLL_KEY;
const OUT_BIB_PATH = process.env.OUT_BIB_PATH || process.env.INPUT_OUT_BIB_PATH || "references.bib";

if (!API_KEY || !LIBRARY_ID || !COLL_KEY) {
  console.error("Missing API_KEY / LIBRARY_ID / COLL_KEY environment variables");
  process.exit(1);
}

// Default to false if IS_GROUP is not provided
const isGroup = (IS_GROUP === "true"); 
const LIBRARY_TYPE = isGroup ? "groups" : "users";
const BASE_URL = `https://api.zotero.org/${LIBRARY_TYPE}/${LIBRARY_ID}`;

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      "Zotero-API-Version": "3",
      "Authorization": `Bearer ${API_KEY}`,
      "Accept": "application/json"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.json();
  const headers = res.headers;
  return { body, headers };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "Zotero-API-Version": "3",
      "Authorization": `Bearer ${API_KEY}`
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  const headers = res.headers;
  return { body, headers };
}

// Some endpoints return an array; others wrap as { items: [...] }.
// Normalize to an array of items.
function normalizeItems(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  return [];
}

// Parse pinned key from Zotero Extra (CSL field 'note').
function pinnedFromNote(note) {
  if (!note) return null;
  const m = note.match(/^\s*Citation Key:\s*([^\s#]+)\s*$/mi);
  return m ? m[1] : null;
}

// Wrap acronyms (2+ consecutive uppercase letters) in {{...}} inside titles
function protectCapitalsInFields(bib, fields = ["title", "booktitle", "series", "number"]) {
  for (const field of fields) {
    const regex = new RegExp(`(${field}\\s*=\\s*\\{)([^}]+)(\\})`, "gi");
    bib = bib.replace(regex, (m, pre, content, post) => {
      const protectedContent = content.replace(/\b([A-Z]{2,})\b/g, '{{$1}}');
      return `${pre}${protectedContent}${post}`;
    });
  }
  return bib;
}

// Clean up 'type' field: remove nested braces like {Policy {Contribution}}
function cleanTypeField(bib) {
  // ^ or \n so we only match a field at line start; 'm' for multiline
  // The big group ((?:[^{}]|{[^{}]*})*) matches any text or a {...} chunk (one level deep)
  const rx = /(^|\n)(\s*)type\s*=\s*\{((?:[^{}]|{[^{}]*})*)\}(\s*,?)/gmi;

  return bib.replace(rx, (m, nl, indent, content, comma) => {
    const cleaned = content.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    return `${nl}${indent}type = {${cleaned}}${comma}`;
  });
}

// CSL → BibTeX type mapping
const typeMap = {
  "article-journal": "article",
  "article": "article",
  "book": "book",
  "chapter": "incollection",
  "paper-conference": "inproceedings",
  "thesis": "thesis",
  "report": "report",
  "webpage": "online",
  "post": "online",
  "post-weblog": "online",
  "dataset": "dataset",
  "manuscript": "unpublished",
};

async function fetchAllParentsCSL() {
  const base = `${BASE_URL}/collections/${COLL_KEY}/items`;
  const params = `?format=csljson&recursive=1&top=1&limit=100&start=`;
  let start = 0, all = [];
  for (;;) {
    const url = `${base}${params}${start}`;
    const { body, headers } = await fetchJSON(url);
    const page = normalizeItems(body);
    const total = parseInt(headers.get("Total-Results") || `${page.length}`, 10);
    console.log(`Fetched ${page.length} items (start=${start}, total≈${total})`);
    all = all.concat(page);
    if (page.length < 100 || all.length >= total) break;
    start += page.length;
  }
  return all;
}

const cslItems = await fetchAllParentsCSL();

const pinnedMap = new Map();
const typeHints = new Map(); // itemKey → CSL type
const itemKeys = [];
for (const it of cslItems) {
  // CSL id format is "<libraryId>/<itemKey>"
  const id = typeof it.id === "string" ? it.id : "";
  const key = id.split("/").pop();
  if (!key) continue;
  itemKeys.push(key);
  const pinned = pinnedFromNote(it.note);
  if (pinned) pinnedMap.set(key, pinned);
  if (it.type) typeHints.set(key, it.type);
}

if (itemKeys.length === 0) {
  console.warn("No parent items found. Check API key group permissions and the collection key.");
}

// Fetch BibTeX for item keys (server translators). Chunk to avoid URL bloat.
async function fetchBibForKeys(keys) {
  const joined = keys.join(",");
  const url = `${BASE_URL}/items?format=bibtex&itemKey=${joined}`;
  const { body } = await fetchText(url);
  return body;
}

let bib = "";
for (let i = 0; i < itemKeys.length; i += 50) {
  const chunk = itemKeys.slice(i, i + 50);
  const part = await fetchBibForKeys(chunk);
  if (part && part.trim()) {
    if (bib && !bib.endsWith("\n")) bib += "\n";
    bib += part.trim() + "\n";
  }
}

// Rewrite entry keys to pinned ones, and remap types
bib = bib.replace(/@(\w+)\{([^,]+),/g, (m, type, k) => {
  const newKey = pinnedMap.get(k) || k;
  const mapped = typeMap[typeHints.get(k)] || type;
  return `@${mapped}{${newKey},`;
});

// Force "organization" instead of "journal" for @online
bib = bib.replace(/(journal\s*=\s*\{)([^}]+)(\})/gi, (m, pre, content, post) => {
  return `organization = {${content}}`;
});

// Escape acronyms in titles
bib = protectCapitalsInFields(bib);

// Clean 'type' field
bib = cleanTypeField(bib);

// await fs.mkdir("extra", { recursive: true });
// await fs.writeFile("extra/references.bib", bib, "utf8");
await fs.mkdir(path.dirname(OUT_BIB_PATH), { recursive: true });
await fs.writeFile(OUT_BIB_PATH, bib, "utf8");

console.log(`Wrote extra/references.bib with ${itemKeys.length} entries (pinned: ${pinnedMap.size})`);
