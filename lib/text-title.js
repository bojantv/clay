function cleanTitleText(text) {
  return String(text || "")
    .replace(/(^|\s)@[A-Za-z0-9_.-]+/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "")
    .trim();
}

function clampTitle(text, maxLen) {
  var value = cleanTitleText(text);
  if (!value) return "";
  if (value.length <= maxLen) return value;
  var clipped = value.slice(0, maxLen + 1);
  var lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLen * 0.65)) clipped = clipped.slice(0, lastSpace);
  else clipped = clipped.slice(0, maxLen);
  return clipped.replace(/[,:;.-]+$/g, "") + "...";
}

function firstMeaningfulLine(lines) {
  var skip = {
    findings: true,
    "test gaps": true,
    implementation: true,
    summary: true,
    details: true,
  };
  for (var i = 0; i < lines.length; i++) {
    var line = cleanTitleText(lines[i]);
    var lower = line.toLowerCase();
    if (!line) continue;
    if (skip[lower]) continue;
    if (/^\d+\.?$/.test(line)) continue;
    if (/^\[[^\]]+\]$/.test(line)) continue;
    if (/^[Pp]\d\b/.test(line)) continue;
    return line;
  }
  return "";
}

function meaningfulTextTitle(text, maxLen) {
  maxLen = maxLen || 80;
  var raw = String(text || "").replace(/\r/g, "");
  // Cap work for huge/binary pastes: only the first few KB / first lines can
  // ever contribute to a 60-char title, so avoid scanning the whole blob.
  if (raw.length > 8192) raw = raw.slice(0, 8192);
  var lines = raw.split("\n");
  if (lines.length > 50) lines = lines.slice(0, 50);
  for (var i = 0; i < lines.length; i++) {
    var commentMatch = lines[i].match(/\bComment on\s+(.+)/i);
    if (commentMatch && commentMatch[1]) return clampTitle(commentMatch[1], maxLen);
  }
  for (var j = 0; j < lines.length; j++) {
    // Anchor to the start of the (trimmed) line so a mid-sentence "#42" does
    // not capture an arbitrary fragment; only fire when the line IS a ref.
    var issueMatch = lines[j].trim().match(/^#\d+\s+(.+)/);
    if (issueMatch && issueMatch[1]) return clampTitle(issueMatch[1], maxLen);
  }
  return clampTitle(firstMeaningfulLine(lines), maxLen);
}

module.exports = { meaningfulTextTitle: meaningfulTextTitle };
