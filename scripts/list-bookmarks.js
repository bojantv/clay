#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const root = path.join(os.homedir(), ".clay", "sessions");
for (const proj of fs.readdirSync(root)) {
  const dir = path.join(root, proj);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dir, f);
    try {
      const fd = fs.openSync(fp, "r");
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const meta = JSON.parse(buf.toString("utf8", 0, n).split("\n")[0]);
      if (meta.bookmarked || meta.favoriteOrder !== undefined) {
        console.log(
          `bm=${!!meta.bookmarked} fo=${meta.favoriteOrder ?? "-"}  ${meta.cliSessionId}  ${meta.title || "(untitled)"}`
        );
      }
    } catch (e) {}
  }
}
