#!/usr/bin/env node
// List all sessions with title, id, project, mtime, hidden
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(os.homedir(), ".clay", "sessions");
const rows = [];

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
      rows.push({
        id: meta.cliSessionId || f.replace(".jsonl", ""),
        title: meta.title || "(untitled)",
        project: proj,
        mtime: st.mtimeMs,
        hidden: !!meta.hidden,
        path: fp,
      });
    } catch (e) {}
  }
}

rows.sort((a, b) => b.mtime - a.mtime);
const arg = process.argv[2];
const limit = arg ? parseInt(arg, 10) : 30;
for (const r of rows.slice(0, limit)) {
  const flag = r.hidden ? "H" : "-";
  const d = new Date(r.mtime).toISOString().slice(0, 16);
  const proj = r.project.length > 40 ? r.project.slice(0, 37) + "..." : r.project;
  console.log(`${flag} ${d}  ${r.id}  [${proj}]  ${r.title}`);
}
console.log(`\nShown: ${Math.min(limit, rows.length)} / Total: ${rows.length}`);
