import * as core from "@actions/core";
import fs from "node:fs/promises";
import path from "node:path";

type CSLItem = {
    id?: string;
    note?: string;
    type?: string;
};

// --- Helpers ---
async function fetchJSON<T>(url: string, API_KEY: string) {
    const res = await fetch(url, {
        headers: {
            "Zotero-API-Version": "3",
            "Authorization": `Bearer ${API_KEY}`,
            "Accept": "application/json"
        }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return { body: (await res.json()) as T, headers: res.headers };
}

async function fetchText(url: string, API_KEY: string) {
    const res = await fetch(url, {
        headers: {
            "Zotero-API-Version": "3",
            "Authorization": `Bearer ${API_KEY}`
        }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return { body: await res.text(), headers: res.headers };
}

function normalizeItems(json: any): CSLItem[] {
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.items)) return json.items;
    return [];
}

function pinnedFromNote(note?: string | null): string | null {
    if (!note) return null;
    const m = note.match(/^\s*Citation Key:\s*([^\s#]+)\s*$/mi);
    return m ? m[1] : null;
}

function protectCapitalsInFields(bib: string, fields = ["title", "booktitle", "series", "number"]) {
    for (const field of fields) {
        const regex = new RegExp(`(${field}\\s*=\\s*\\{)([^}]+)(\\})`, "gi");
        bib = bib.replace(regex, (m, pre, content, post) => {
            const protectedContent = content.replace(/\b([A-Z]{2,})\b/g, '{{$1}}');
            return `${pre}${protectedContent}${post}`;
        });
    }
    return bib;
}

function cleanTypeField(bib: string) {
    const rx = /(^|\n)(\s*)type\s*=\s*\{((?:[^{}]|{[^{}]*})*)\}(\s*,?)/gmi;
    return bib.replace(rx, (m, nl, indent, content, comma) => {
        const cleaned = content.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
        return `${nl}${indent}type = {${cleaned}}${comma}`;
    });
}

const typeMap: Record<string, string> = {
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

// --- Main ---
async function run() {
    try {
        const API_KEY = core.getInput("api-key", { required: true });
        const LIBRARY_ID = core.getInput("library-id", { required: true });
        const COLL_KEY = core.getInput("coll-key", { required: true });
        const IS_GROUP = core.getInput("is-group") || "false";
        const OUT_BIB_PATH = core.getInput("out-bib-path") || "references.bib";

        const isGroup = IS_GROUP === "true";
        const LIBRARY_TYPE = isGroup ? "groups" : "users";
        const BASE_URL = `https://api.zotero.org/${LIBRARY_TYPE}/${LIBRARY_ID}`;

        async function fetchAllParentsCSL(): Promise<CSLItem[]> {
            const base = `${BASE_URL}/collections/${COLL_KEY}/items`;
            const params = `?format=csljson&recursive=1&top=1&limit=100&start=`;
            let start = 0, all: CSLItem[] = [];
            for (; ;) {
                const url = `${base}${params}${start}`;
                const { body, headers } = await fetchJSON<any>(url, API_KEY);
                const page = normalizeItems(body);
                const total = parseInt(headers.get("Total-Results") || `${page.length}`, 10);
                core.info(`Fetched ${page.length} items (start=${start}, total≈${total})`);
                all = all.concat(page);
                if (page.length < 100 || all.length >= total) break;
                start += page.length;
            }
            return all;
        }

        const cslItems = await fetchAllParentsCSL();

        const pinnedMap = new Map<string, string>();
        const typeHints = new Map<string, string>();
        const itemKeys: string[] = [];

        for (const it of cslItems) {
            const id = typeof it.id === "string" ? it.id : "";
            const key = id.split("/").pop();
            if (!key) continue;
            itemKeys.push(key);
            const pinned = pinnedFromNote(it.note);
            if (pinned) pinnedMap.set(key, pinned);
            if (it.type) typeHints.set(key, it.type);
        }

        if (itemKeys.length === 0) {
            core.warning("No parent items found. Check API key permissions and collection key.");
        }

        async function fetchBibForKeys(keys: string[]) {
            const joined = keys.join(",");
            const url = `${BASE_URL}/items?format=bibtex&itemKey=${joined}`;
            const { body } = await fetchText(url, API_KEY);
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

        bib = bib.replace(/@(\w+)\{([^,]+),/g, (m, type, k) => {
            const newKey = pinnedMap.get(k) || k;
            const mapped = typeMap[typeHints.get(k) || ""] || type;
            return `@${mapped}{${newKey},`;
        });

        bib = bib.replace(/(journal\s*=\s*\{)([^}]+)(\})/gi, (_, pre, content) => {
            return `organization = {${content}}`;
        });

        bib = protectCapitalsInFields(bib);
        bib = cleanTypeField(bib);

        await fs.mkdir(path.dirname(OUT_BIB_PATH), { recursive: true });
        await fs.writeFile(OUT_BIB_PATH, bib, "utf8");

        core.info(`Wrote ${OUT_BIB_PATH} with ${itemKeys.length} entries (pinned: ${pinnedMap.size})`);
    } catch (error: any) {
        core.setFailed(error.message);
    }
}

run();