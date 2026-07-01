#!/usr/bin/env node
// One-off importer: parse a Pulse-card markdown deck and load it into Supabase
// as a new engagement + cards. Run with:
//
//   node --env-file=.env.local scripts/import-deck.mjs \
//     "../Pulse Card Markdowns/<file>.md" \
//     --name "Rachel Kerr" \
//     --org "BeautyBoost" \
//     --engagement "The Beauty Boost Onboarding Pulse Check"
//
// The deck file is expected to use the format produced for BeautyBoost:
//   ## Card N: <title>
//   **Category:** ...
//   **Type:** confirm-edit | single-select | multi-select | short-text | long-text | file-upload | document-link | contact-share
//   **Skip:** optional | required
//   **Context:** <para>
//   **Question:** <text>
//   **Options:** (only for *-select)
//   - opt 1
//   - opt 2

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const VALID_TYPES = new Set([
  "confirm-edit",
  "single-select",
  "multi-select",
  "short-text",
  "long-text",
  "file-upload",
  "document-link",
  "contact-share",
]);

function parseArgs(argv) {
  const args = { path: null, name: null, org: null, engagement: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") args.name = argv[++i];
    else if (a === "--org") args.org = argv[++i];
    else if (a === "--engagement") args.engagement = argv[++i];
    else rest.push(a);
  }
  args.path = rest[0] ?? null;
  return args;
}

function parseDeck(md) {
  // Split on horizontal rules. The card sections live between them.
  const blocks = md.split(/\n---\n/);
  const cards = [];
  for (const block of blocks) {
    const titleMatch = block.match(/^##\s*Card\s+(\d+):\s*(.+?)\s*$/m);
    if (!titleMatch) continue;
    const order_index = Number(titleMatch[1]);
    const title = titleMatch[2].trim();

    const category = pick(block, /\*\*Category:\*\*\s*(.+?)\s*$/m);
    const response_type = pick(block, /\*\*Type:\*\*\s*(.+?)\s*$/m);
    const skipRaw = pick(block, /\*\*Skip:\*\*\s*(.+?)\s*$/m);

    if (!category || !response_type || !skipRaw) {
      throw new Error(`Card ${order_index} (${title}) is missing category/type/skip`);
    }
    if (!VALID_TYPES.has(response_type)) {
      throw new Error(
        `Card ${order_index} (${title}) has unknown type "${response_type}". ` +
          `Allowed: ${[...VALID_TYPES].join(", ")}`
      );
    }
    const skip_allowed = skipRaw.toLowerCase() === "optional";

    const context = pickSection(block, "Context");
    const question = pickSection(block, "Question");
    if (!context) throw new Error(`Card ${order_index} (${title}) has no Context paragraph`);
    if (!question) throw new Error(`Card ${order_index} (${title}) has no Question`);

    let options = null;
    if (response_type === "single-select" || response_type === "multi-select") {
      options = pickOptions(block);
      if (!options || options.length === 0) {
        throw new Error(`Card ${order_index} (${title}) is ${response_type} but has no Options list`);
      }
    }

    const attachment_path = pick(block, /\*\*Attachment:\*\*\s*(.+?)\s*$/m) || null;

    cards.push({
      order_index,
      category,
      title,
      context,
      question,
      response_type,
      options,
      skip_allowed,
      attachment_path,
    });
  }
  cards.sort((a, b) => a.order_index - b.order_index);
  return cards;
}

function pick(block, re) {
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// Grab the paragraph that follows a **Label:** line, up to the next
// **Bold:** label or end of block.
function pickSection(block, label) {
  // No `m` flag: `$` must mean end-of-input, not end-of-line, so the
  // capture can span multiple lines when the section is last in the block.
  const re = new RegExp(
    `\\*\\*${label}:\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*[A-Z][^*]*:\\*\\*|$)`
  );
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function pickOptions(block) {
  const section = pickSection(block, "Options");
  if (!section) return null;
  return section
    .split("\n")
    .map((line) => line.replace(/^\s*-\s+/, "").trim())
    .filter(Boolean);
}

function makeToken() {
  // Match admin.ts seed format: 8 random bytes → 16 hex chars.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const { path, name, org, engagement } = parseArgs(process.argv.slice(2));
if (!path || !name) {
  console.error(
    "Usage: node --env-file=.env.local scripts/import-deck.mjs <markdown-path> --name <contact> [--org <org>] [--engagement <label>]"
  );
  process.exit(2);
}

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

const absPath = resolve(process.cwd(), path);
const md = readFileSync(absPath, "utf8");
const cards = parseDeck(md);

console.log(`Parsed ${cards.length} cards from ${absPath}\n`);
for (const c of cards) {
  const skip = c.skip_allowed ? "skip ok " : "REQUIRED";
  const opts = c.options ? ` (${c.options.length} options)` : "";
  console.log(
    `  ${String(c.order_index).padStart(2, " ")}. [${c.category}] ${c.title}  (${c.response_type}, ${skip})${opts}`
  );
}

// Sanity: contiguous order_index starting at 1.
for (let i = 0; i < cards.length; i++) {
  if (cards[i].order_index !== i + 1) {
    throw new Error(
      `order_index gap: card ${i + 1} has order_index ${cards[i].order_index}`
    );
  }
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const token = makeToken();
console.log(`\nCreating engagement "${engagement ?? name}" with token ${token}...`);

const { data: client, error: clientErr } = await supabase
  .from("clients")
  .insert({
    name,
    org_name: org || null,
    engagement_name: engagement || null,
    token,
  })
  .select()
  .single();

if (clientErr || !client) {
  console.error("FAIL: could not create client row.", clientErr?.message);
  process.exit(1);
}
console.log(`  client_id: ${client.id}`);

const rows = cards.map((c) => ({ ...c, client_id: client.id }));
const { error: cardsErr } = await supabase.from("cards").insert(rows);

if (cardsErr) {
  console.error("FAIL: could not insert cards.", cardsErr.message);
  console.error("Rolling back client row...");
  const { error: delErr } = await supabase.from("clients").delete().eq("id", client.id);
  if (delErr) {
    console.error(
      `Rollback failed too. Delete client ${client.id} manually.`,
      delErr.message
    );
  }
  process.exit(1);
}

console.log(`Inserted ${rows.length} cards.\n`);
console.log(`Recipient URL:`);
console.log(`  https://tomdigati.github.io/pulse/?t=${token}`);
