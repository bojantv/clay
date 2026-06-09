#!/usr/bin/env node
// Delete sessions in the UI's Today + Yesterday buckets (matches the sidebar's
// "Clear" button for those groups). Uses mtime, which is what the daemon uses
// for lastActivity / group assignment. Keeps This Week + Older intact.
//
// Usage:
//   node scripts/clear-today-yesterday.js           # dry-run
//   node scripts/clear-today-yesterday.js --apply   # actually delete files
//
// Stop the daemon before --apply.

const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(os.homedir(), ".clay", "sessions");
const apply = process.argv.includes("--apply");

const keepFile = path.join(__dirname, "keep-list.txt");
const keep = new Set();
if (fs.existsSync(keepFile)) {
  for (const l of fs.readFileSync(keepFile, "utf8").split("\n")) {
    const t = l.trim();
    if (t && !t.startsWith("#")) keep.add(t);
  }
}
console.log(`Keep list: ${keep.size} ids`);

function getDateGroup(ts) {
  const now = new Date();
  const d = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  if (d >= today) return "Today";
  if (d >= yesterday) return "Yesterday";
  if (d >= weekAgo) return "This Week";
  return "Older";
}

const buckets = { Today: [], Yesterday: [], "This Week": [], Older: [] };

for (const proj of fs.readdirSync(root)) {
  const dir = path.join(root, proj);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dir, f);
    try {
      const st = fs.statSync(fp);
      const fd = fs.openSync(fp, "r");
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString("utf8", 0, n).split("\n")[0];
      const meta = JSON.parse(firstLine);
      const grp = getDateGroup(st.mtimeMs);
      buckets[grp].push({
        fp,
        title: meta.title || "(untitled)",
        id: meta.cliSessionId || f,
        bookmarked: !!meta.bookmarked,
      });
    } catch (e) {}
  }
}

for (const k of Object.keys(buckets)) {
  console.log(`${k}: ${buckets[k].length}`);
}

const toDelete = [...buckets.Today, ...buckets.Yesterday].filter(
  (s) => !keep.has(s.id) && !s.bookmarked
);
const total = buckets.Today.length + buckets.Yesterday.length;
const skipped = total - toDelete.length;
console.log(`\nKeep-list + bookmarked skipped: ${skipped}`);
console.log(`Will ${apply ? "DELETE" : "(dry-run) delete"}: ${toDelete.length} sessions`);
if (toDelete.length && !apply) {
  console.log("\nSample of first 15:");
  for (const s of toDelete.slice(0, 15)) console.log(`  ${s.id}  ${s.title}`);
  console.log("\nDry run. Re-run with --apply to actually delete.");
}
if (apply) {
  for (const s of toDelete) {
    try {
      fs.unlinkSync(s.fp);
    } catch (e) {
      console.error(`Failed to delete ${s.fp}: ${e.message}`);
    }
  }
  console.log(`Deleted ${toDelete.length} files.`);
}
