import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import slugify from "slugify";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";

dotenv.config();

const required = ["NOTION_TOKEN", "NOTION_DATABASE_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

const propName = {
  title: process.env.NOTION_PROP_TITLE || "Title",
  date: process.env.NOTION_PROP_DATE || "Date",
  tags: process.env.NOTION_PROP_TAGS || "Tags",
  published: process.env.NOTION_PROP_PUBLISHED || "Published"
};

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const postsDir = path.join(root, "source", "_posts");

function readTitle(properties) {
  const p = properties[propName.title];
  if (!p || p.type !== "title") return "untitled";
  const value = p.title.map((x) => x.plain_text).join("").trim();
  return value || "untitled";
}

function readDate(properties, fallbackISO) {
  const p = properties[propName.date];
  if (!p || p.type !== "date" || !p.date?.start) return fallbackISO;
  return p.date.start.slice(0, 10);
}

function readTags(properties) {
  const p = properties[propName.tags];
  if (!p || p.type !== "multi_select") return [];
  return p.multi_select.map((x) => x.name).filter(Boolean);
}

function readPublished(properties) {
  const p = properties[propName.published];
  if (!p || p.type !== "checkbox") return false;
  return Boolean(p.checkbox);
}

function toFrontMatter({ title, date, tags, notionPageId }) {
  const safeTitle = title.replace(/"/g, "\\\"");
  const tagsBlock = tags.length
    ? `\ntags:\n${tags.map((tag) => `- ${tag}`).join("\n")}`
    : "";

  return `---\ntitle: \"${safeTitle}\"\ndate: ${date}\nnotion_page_id: ${notionPageId}${tagsBlock}\n---\n`;
}

async function queryAllPages() {
  const out = [];
  let cursor;

  do {
    const res = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
      sorts: [{ timestamp: "created_time", direction: "descending" }]
    });

    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return out;
}

async function upsertPage(page) {
  const createdISO = page.created_time.slice(0, 10);
  const title = readTitle(page.properties);
  const date = readDate(page.properties, createdISO);
  const tags = readTags(page.properties);
  const slug = slugify(title, { lower: true, strict: true, trim: true }) || page.id.slice(0, 8);
  const filename = `${date}-${slug}.md`;
  const file = path.join(postsDir, filename);

  const mdBlocks = await n2m.pageToMarkdown(page.id);
  const mdString = n2m.toMarkdownString(mdBlocks);
  const body = mdString.parent || "";

  const frontMatter = toFrontMatter({ title, date, tags, notionPageId: page.id });
  const content = `${frontMatter}\n${body}\n`;

  await fs.writeFile(file, content, "utf8");
  console.log(`Wrote source/_posts/${filename}`);
}

async function main() {
  await fs.mkdir(postsDir, { recursive: true });

  const pages = await queryAllPages();
  const published = pages.filter((p) => readPublished(p.properties));

  console.log(`Fetched ${pages.length} pages, ${published.length} published.`);

  for (const page of published) {
    await upsertPage(page);
  }

  console.log("Notion sync completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
