// Pulls the newest published entry from the Notion "Personal Website Diary"
// database and writes it into index.html, between the journal markers.
//
// Runs in GitHub Actions (see .github/workflows/update-journal.yml).
// To run it on your computer:
//   NOTION_TOKEN=secret_xxx node scripts/update-journal.mjs
//
// Needs no packages, only Node 20 or newer.

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NOTION_VERSION = "2022-06-28";
const DATABASE_ID = process.env.NOTION_DATABASE_ID ?? "419721750a4880fab1cec4a7e784d4ca";
const TIMEZONE = process.env.TIMEZONE ?? "Europe/Berlin"; // only used when Date is empty
const HTML_FILE = process.env.HTML_FILE ?? "index.html";

const START = "<!-- journal:start -->";
const END = "<!-- journal:end -->";

/* ---------- Notion API ---------- */

async function notion(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Notion API ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}

async function publishedEntries() {
  const pages = [];
  let cursor;
  do {
    const data = await notion(`databases/${DATABASE_ID}/query`, {
      method: "POST",
      body: {
        filter: { property: "Published", checkbox: { equals: true } },
        start_cursor: cursor,
        page_size: 100,
      },
    });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function pageBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const data = await notion(`blocks/${pageId}/children?${query}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

/* ---------- dates ---------- */

// Returns the wall-clock moment of an entry: the Date property exactly as
// typed in Notion, or, if Date is empty, the page's creation time in TIMEZONE.
export function entryMoment(page, timeZone = TIMEZONE) {
  const typed = page.properties?.Date?.date?.start;
  if (typed) {
    const m = typed.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    return {
      year: +m[1], month: +m[2], day: +m[3],
      hour: m[4] ? +m[4] : null, minute: m[5] ? +m[5] : null,
    };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(page.created_time)).map((p) => [p.type, p.value])
  );
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute,
  };
}

const pad = (n) => String(n).padStart(2, "0");

// "Sunday, November 15, 21:33" (time left out if the entry has none)
export function displayDate(t) {
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day));
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
  }).format(d);
  return t.hour === null ? day : `${day}, ${pad(t.hour)}:${pad(t.minute)}`;
}

// "2026-11-15T21:33" for the <time datetime=""> attribute
export function machineDate(t) {
  const day = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  return t.hour === null ? day : `${day}T${pad(t.hour)}:${pad(t.minute)}`;
}

const sortKey = (t) => machineDate({ ...t, hour: t.hour ?? 0, minute: t.minute ?? 0 });

/* ---------- Notion text to HTML ---------- */

const escape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function richTextToHtml(richText = []) {
  return richText
    .map((rt) => {
      let html = escape(rt.plain_text).replace(/\n/g, "<br>");
      const a = rt.annotations ?? {};
      if (a.code) html = `<code>${html}</code>`;
      if (a.bold) html = `<strong>${html}</strong>`;
      if (a.italic) html = `<em>${html}</em>`;
      if (a.strikethrough) html = `<s>${html}</s>`;
      if (a.underline) html = `<u>${html}</u>`;
      if (rt.href) html = `<a href="${escape(rt.href)}">${html}</a>`;
      return html;
    })
    .join("");
}

export function blocksToHtml(blocks, indent) {
  const out = [];
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "quote") {
      const html = richTextToHtml(block[block.type].rich_text).trim();
      if (!html) continue; // skip empty lines
      out.push(
        block.type === "quote"
          ? `${indent}<blockquote><p>${html}</p></blockquote>`
          : `${indent}<p>${html}</p>`
      );
    } else {
      console.warn(`Skipping a "${block.type}" block (only paragraphs and quotes are shown).`);
    }
  }
  return out.join("\n");
}

export function renderArticle(moment, bodyHtml) {
  return [
    `        <article class="journal-entry">`,
    `            <header class="journal-entry-header">`,
    `                <h2 class="visually-hidden">Journal</h2>`,
    `                <time datetime="${machineDate(moment)}">${displayDate(moment)}</time>`,
    `            </header>`,
    bodyHtml,
    `        </article>`,
  ].join("\n");
}

export function replaceBetweenMarkers(html, inner) {
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find ${START} … ${END} in ${HTML_FILE}.`);
  }
  return html.slice(0, start + START.length) + "\n" + inner + "\n        " + html.slice(end);
}

/* ---------- main ---------- */

async function main() {
  if (!process.env.NOTION_TOKEN) throw new Error("NOTION_TOKEN is not set.");

  const pages = await publishedEntries();
  if (pages.length === 0) {
    console.log("No published entries in Notion. Leaving the page as it is.");
    return;
  }

  const newest = pages
    .map((page) => ({ page, moment: entryMoment(page) }))
    .sort((a, b) => sortKey(b.moment).localeCompare(sortKey(a.moment)))[0];

  const body = blocksToHtml(await pageBlocks(newest.page.id), " ".repeat(12));
  if (!body) {
    console.log("The newest published entry has no text. Leaving the page as it is.");
    return;
  }

  const html = await readFile(HTML_FILE, "utf8");
  const updated = replaceBetweenMarkers(html, renderArticle(newest.moment, body));
  if (updated === html) {
    console.log("Journal entry is already up to date.");
    return;
  }
  await writeFile(HTML_FILE, updated);
  console.log(`Updated ${HTML_FILE} with the entry from ${displayDate(newest.moment)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
