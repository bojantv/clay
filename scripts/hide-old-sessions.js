#!/usr/bin/env node
// Hide all sessions EXCEPT those listed in keep-list.txt.
// Usage:
//   node scripts/hide-old-sessions.js               # dry-run
//   node scripts/hide-old-sessions.js --apply       # actually edit files
//
// keep-list.txt: one session ID (UUID) per line. Lines starting with # are ignored.
// Sessions whose ID is in the keep list are left as-is; all others get hidden:true
// added to their meta line. Daemon must be stopped before --apply.

const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(os.homedir(), ".clay", "sessions");
const keepFile = path.join(__dirname, "keep-list.txt");
const apply = process.argv.includes("--apply");

if (!fs.existsSync(keepFile)) {
  console.error(`Missing ${keepFile}. Create it with one session ID per line.`);
  process.exit(1);
}

const keep = new Set(
  fs
    .readFileSync(keepFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
);

console.log(`Keep list: ${keep.size} ids`);

let scanned = 0,
  willHide = 0,
  alreadyHidden = 0,
  kept = 0;

for (const proj of fs.readdirSync(root)) {
  const dir = path.join(root, proj);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dir, f);
    scanned++;
    const content = fs.readFileSync(fp, "utf8");
    const nl = content.indexOf("\n");
    const firstLine = nl === -1 ? content : content.slice(0, nl);
    const rest = nl === -1 ? "" : content.slice(nl);
    let meta;
    try {
      meta = JSON.parse(firstLine);
    } catch (e) {
      continue;
    }
    const id = meta.cliSessionId || f.replace(".jsonl", "");
    if (keep.has(id)) {
      kept++;
      continue;
    }
    if (meta.hidden) {
      alreadyHidden++;
      continue;
    }
    willHide++;
    if (apply) {
      meta.hidden = true;
      fs.writeFileSync(fp, JSON.stringify(meta) + rest);
    }
  }
}

console.log(`Scanned: ${scanned}`);
console.log(`Keep matches: ${kept}`);
console.log(`Already hidden: ${alreadyHidden}`);
console.log(`${apply ? "Hidden" : "Would hide"}: ${willHide}`);
if (!apply) console.log(`\nDry run. Re-run with --apply to write changes.`);
