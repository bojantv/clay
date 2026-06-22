// project-task-wizard.js - Task Launcher setup (Project Settings → Task
// Launchers). Two surfaces sharing one backend:
//   - New project: a guided multi-step modal (#task-setup-wizard, "tsw-" ids)
//     that discovers the Projects-v2 board via gh GraphQL and scaffolds
//     recipes + config + TRIAGE.local.md.
//   - Configured project: an inline editable settings form (#tsw-inline,
//     "tsi-" ids) that updates the recipe + config.json only.
//
// Once the gh account is known, fields are populated from GitHub: repos
// (datalist), board status columns (checkboxes), labels (checkboxes), and
// collaborators (assignee select). A single discover call returns board +
// labels + collaborators.
//
// Client ES module. var only, no arrow functions. WebSocket via ws-ref.js.

import { getWs } from './ws-ref.js';
import { refreshIcons } from './icons.js';
import { escapeHtml, showToast } from './utils.js';

var LAST_STEP = 5;

// --- Wizard (modal) step state ---
var wizardStep = 1;
var lastDiscoverKey = "";   // repo|account boards were fetched for (modal)
var awaitingDiscover = false;
var scaffolding = false;

// --- Shared state ---
var activeScope = "tsi";        // "tsw" = modal, "tsi" = inline section
var boardsByScope = { tsw: [], tsi: [] };
var savedSkipStatuses = [];     // restored as ticks after discovery
var savedExcludeLabels = [];    // restored as ticks after discovery
var pendingAccount = "";        // account selected once dropdown loads
var pendingAssigned = "me";     // assignee selected once collaborators load
var inlineRecipeId = "assigned-to-me";
var modalEl = null;

function el(id) { return document.getElementById(id); }
function setVal(id, value) { var e = el(id); if (e != null && value != null) e.value = value; }
function setChecked(id, on) { var e = el(id); if (e) e.checked = !!on; }

function wsSend(obj) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function initTaskWizard() {
  modalEl = el("task-setup-wizard");
  if (modalEl) {
    var closeBtn = el("tsw-close");
    var backdrop = modalEl.querySelector(".ralph-wizard-backdrop");
    var backBtn = el("tsw-back");
    var nextBtn = el("tsw-next");
    if (closeBtn) closeBtn.addEventListener("click", closeTaskWizard);
    if (backdrop) backdrop.addEventListener("click", closeTaskWizard);
    if (backBtn) backBtn.addEventListener("click", wizardBack);
    if (nextBtn) nextBtn.addEventListener("click", wizardNext);
    var vendor = el("tsw-vendor");
    if (vendor) vendor.addEventListener("input", function () { updateVendorLabel("tsw"); });
    var account = el("tsw-account");
    if (account) account.addEventListener("change", requestRepos);
    var boardSel = el("tsw-board");
    if (boardSel) boardSel.addEventListener("change", function () { renderStatusList("tsw"); });
    var copyBtn = el("tsw-copy-prompt");
    if (copyBtn) copyBtn.addEventListener("click", copyWebsitePrompt);
  }
  // Inline section listeners.
  var iv = el("tsi-vendor");
  if (iv) iv.addEventListener("input", function () { updateVendorLabel("tsi"); });
  var saveBtn = el("tsi-save");
  if (saveBtn) saveBtn.addEventListener("click", saveInline);
  var iBoard = el("tsi-board");
  if (iBoard) iBoard.addEventListener("change", function () { renderStatusList("tsi"); });
  var iAccount = el("tsi-account");
  if (iAccount) iAccount.addEventListener("change", function () { requestRepos(); triggerDiscover("tsi"); });
  var iRepo = el("tsi-repo");
  if (iRepo) iRepo.addEventListener("change", function () { triggerDiscover("tsi"); });
}

// Called by project-settings when the Task Launchers section opens.
export function loadTaskLauncherSection() {
  activeScope = "tsi";
  pendingAccount = "";
  wsSend({ type: "task_setup_state" });
  wsSend({ type: "task_setup_accounts" });
}

// --- Wizard (modal) --------------------------------------------------------

export function openTaskWizard() {
  if (!modalEl) initTaskWizard();
  if (!modalEl) return;
  activeScope = "tsw";
  wizardStep = 1;
  boardsByScope.tsw = [];
  lastDiscoverKey = "";
  awaitingDiscover = false;
  scaffolding = false;
  savedSkipStatuses = [];
  savedExcludeLabels = [];
  pendingAccount = "";
  pendingAssigned = "me";
  setVal("tsw-repo", "");
  setVal("tsw-recipe-id", "assigned-to-me");
  setVal("tsw-recipe-name", "");
  setVal("tsw-type", "bug");
  setVal("tsw-title-prefixes", "");
  setVal("tsw-confidence", 80);
  setVal("tsw-dash-port", 8765);
  setVal("tsw-cron", "*/5 * * * *");
  setChecked("tsw-enabled", true);
  setChecked("tsw-create-manual", true);
  setChecked("tsw-overwrite-triage", false);
  var v = el("tsw-vendor"); if (v) v.value = 70;
  updateVendorLabel("tsw");
  var statusList = el("tsw-status-list"); if (statusList) statusList.innerHTML = "";
  var labelList = el("tsw-label-list"); if (labelList) labelList.innerHTML = "";
  setDiscoverStatus("");
  modalEl.classList.remove("hidden");
  updateStep();
  wsSend({ type: "task_setup_accounts" });
  refreshIcons();
}

export function closeTaskWizard() {
  if (modalEl) modalEl.classList.add("hidden");
  awaitingDiscover = false;
  scaffolding = false;
  loadTaskLauncherSection();
}

function updateStep() {
  if (!modalEl) return;
  var steps = modalEl.querySelectorAll(".ralph-step");
  for (var i = 0; i < steps.length; i++) {
    var n = parseInt(steps[i].getAttribute("data-step"), 10);
    steps[i].classList.toggle("active", n === wizardStep);
  }
  var dots = modalEl.querySelectorAll(".ralph-dot");
  for (var j = 0; j < dots.length; j++) {
    var dn = parseInt(dots[j].getAttribute("data-step"), 10);
    dots[j].classList.toggle("active", dn === wizardStep);
    dots[j].classList.toggle("done", dn < wizardStep);
  }
  var backBtn = el("tsw-back");
  if (backBtn) backBtn.style.visibility = (wizardStep === 1 || wizardStep === LAST_STEP) ? "hidden" : "visible";
  var nextBtn = el("tsw-next");
  if (nextBtn) {
    if (wizardStep === 4) nextBtn.textContent = scaffolding ? "Creating…" : "Create";
    else if (wizardStep === LAST_STEP) nextBtn.textContent = "Done";
    else nextBtn.textContent = "Next";
    nextBtn.disabled = awaitingDiscover || scaffolding;
  }
}

function wizardBack() {
  if (wizardStep > 1) { wizardStep--; updateStep(); }
}

function wizardNext() {
  if (wizardStep === 1) { advanceFromRepo(); return; }
  if (wizardStep === 2) { wizardStep = 3; updateStep(); return; }
  if (wizardStep === 3) {
    if (!validateAutomation()) return;
    renderReview();
    wizardStep = 4;
    updateStep();
    return;
  }
  if (wizardStep === 4) { submitScaffold(); return; }
  if (wizardStep === LAST_STEP) { closeTaskWizard(); return; }
}

function advanceFromRepo() {
  var repo = (el("tsw-repo").value || "").trim();
  if (repo.split("/").length !== 2 || !repo.split("/")[0] || !repo.split("/")[1]) {
    setDiscoverStatus("Enter a repo in owner/name form (e.g. trialview/v2).", true);
    return;
  }
  var account = el("tsw-account").value || "";
  var key = repo + "|" + account;
  if (key === lastDiscoverKey && boardsByScope.tsw.length) { wizardStep = 2; updateStep(); return; }
  awaitingDiscover = true;
  setDiscoverStatus("Discovering project board, labels and collaborators…");
  updateStep();
  activeScope = "tsw";
  wsSend({ type: "task_setup_discover", repo: repo, ghAccount: account });
}

function validateAutomation() {
  var id = (el("tsw-recipe-id").value || "").trim();
  if (!id) { showToast("Recipe id is required"); return false; }
  var cron = (el("tsw-cron").value || "").trim();
  if (cron && cron.split(/\s+/).length !== 5) { showToast("Cron must have 5 fields"); return false; }
  return true;
}

function triggerDiscover(scope) {
  var repo = (el(scope + "-repo").value || "").trim();
  if (repo.split("/").length !== 2 || !repo.split("/")[0] || !repo.split("/")[1]) return;
  var accEl = el(scope + "-account");
  activeScope = scope;
  wsSend({ type: "task_setup_discover", repo: repo, ghAccount: accEl ? accEl.value : "" });
}

function requestRepos() {
  var sel = el(activeScope + "-account");
  wsSend({ type: "task_setup_repos", ghAccount: sel ? sel.value : "" });
}

function setDiscoverStatus(text, isError) {
  var s = el("tsw-discover-status");
  if (!s) return;
  s.textContent = text || "";
  s.style.color = isError ? "var(--danger, #e74c3c)" : "";
}

// --- Shared helpers (scope = "tsw" | "tsi") --------------------------------

function updateVendorLabel(scope) {
  var v = el(scope + "-vendor");
  var label = el(scope + "-vendor-label");
  if (!v || !label) return;
  var claude = parseInt(v.value, 10);
  if (!Number.isFinite(claude)) claude = 70;
  label.textContent = claude + "% Claude · " + (100 - claude) + "% Codex";
}

function vendorWeights(scope) {
  var v = el(scope + "-vendor");
  var claude = v ? parseInt(v.value, 10) : 70;
  if (!Number.isFinite(claude)) claude = 70;
  var w = {};
  if (claude > 0) w.claude = claude;
  if (100 - claude > 0) w.codex = 100 - claude;
  return w;
}

function applyVendorPct(scope, weights) {
  var w = weights || {};
  var claude = parseInt(w.claude, 10);
  var codex = parseInt(w.codex, 10);
  var total = (claude || 0) + (codex || 0);
  var pct = total > 0 ? Math.round(((claude || 0) / total) * 100) : 70;
  var v = el(scope + "-vendor");
  if (v) { v.value = pct; updateVendorLabel(scope); }
}

function splitCsv(value) {
  return String(value || "").split(",").map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
}

function selectedBoard(scope) {
  var sel = el(scope + "-board");
  var arr = boardsByScope[scope] || [];
  if (!sel) return null;
  var idx = parseInt(sel.value, 10);
  return (Number.isFinite(idx) && arr[idx]) ? arr[idx] : null;
}

// Pre-tick columns that look done-ish so the common case is one click.
function looksDone(name) {
  return /done|complete|ready|closed|shipped|cancel|won't|wont/i.test(String(name || ""));
}

function renderStatusList(scope) {
  var list = el(scope + "-status-list");
  if (!list) return;
  var board = selectedBoard(scope);
  var options = (board && Array.isArray(board.options)) ? board.options : [];
  if (!options.length) {
    list.innerHTML = '<div class="ralph-hint" style="margin:0;">No status columns found for this board.</div>';
    return;
  }
  var useSaved = savedSkipStatuses.length > 0;
  var html = "";
  for (var i = 0; i < options.length; i++) {
    var name = options[i].name || "";
    var on = useSaved ? savedSkipStatuses.indexOf(name) !== -1 : looksDone(name);
    html += '<label><input type="checkbox" value="' + escapeHtml(name) + '"' + (on ? " checked" : "") + '> ' + escapeHtml(name) + "</label>";
  }
  list.innerHTML = html;
}

function renderLabelList(scope, labels) {
  var list = el(scope + "-label-list");
  if (!list) return;
  var all = (labels || []).slice();
  for (var s = 0; s < savedExcludeLabels.length; s++) {
    if (all.indexOf(savedExcludeLabels[s]) === -1) all.push(savedExcludeLabels[s]);
  }
  if (!all.length) {
    list.innerHTML = '<div class="ralph-hint" style="margin:0;">No labels found for this repo.</div>';
    return;
  }
  var html = "";
  for (var i = 0; i < all.length; i++) {
    var name = all[i];
    var on = savedExcludeLabels.indexOf(name) !== -1;
    html += '<label><input type="checkbox" value="' + escapeHtml(name) + '"' + (on ? " checked" : "") + '> ' + escapeHtml(name) + "</label>";
  }
  list.innerHTML = html;
}

function buildAssignee(scope, collaborators) {
  var sel = el(scope + "-assigned");
  if (!sel) return;
  var want = pendingAssigned || sel.value || "me";
  sel.innerHTML = "";
  function add(v, t) { var o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
  add("me", "Assigned to me");
  add("any", "Anyone");
  var list = collaborators || [];
  for (var i = 0; i < list.length; i++) add(list[i], list[i]);
  sel.value = want;
  if (sel.value !== want) { add(want, want); sel.value = want; }
}

function checkedValues(containerId, fallback) {
  var c = el(containerId);
  var cbs = c ? c.querySelectorAll('input[type="checkbox"]') : [];
  if (!cbs.length) return (fallback || []).slice();
  var out = [];
  for (var i = 0; i < cbs.length; i++) if (cbs[i].checked) out.push(cbs[i].value);
  return out;
}

function collectConfig(scope) {
  var board = selectedBoard(scope);
  var recipeId = scope === "tsw" ? (el("tsw-recipe-id").value || "").trim() : (inlineRecipeId || "assigned-to-me");
  var overwriteEl = el("tsw-overwrite-triage");
  var accEl = el(scope + "-account");
  return {
    repo: (el(scope + "-repo").value || "").trim(),
    ghAccount: accEl ? (accEl.value || "") : "",
    recipeId: recipeId,
    recipeName: (el(scope + "-recipe-name").value || "").trim(),
    board: (board && board.id) ? {
      id: board.id, title: board.title, number: board.number,
      statusFieldId: board.statusFieldId, options: board.options,
    } : {},
    skipStatuses: checkedValues(scope + "-status-list", savedSkipStatuses),
    includeStatuses: [],
    issueType: el(scope + "-type").value || "",
    assigned: el(scope + "-assigned").value || "me",
    excludeLabels: checkedValues(scope + "-label-list", savedExcludeLabels),
    titleExcludePrefixes: splitCsv(el(scope + "-title-prefixes") ? el(scope + "-title-prefixes").value : ""),
    vendorWeights: vendorWeights(scope),
    cron: (el(scope + "-cron").value || "").trim() || "*/5 * * * *",
    enabled: !!el(scope + "-enabled").checked,
    confidenceThreshold: parseInt(el(scope + "-confidence").value, 10) || 80,
    dashboardPort: parseInt(el(scope + "-dash-port").value, 10) || 8765,
    createManual: !!el(scope + "-create-manual").checked,
    overwriteTriage: scope === "tsw" ? !!(overwriteEl && overwriteEl.checked) : false,
    fetchLimit: 100,
    defaultLimit: 10,
    environment: "",
  };
}

function renderReview() {
  var c = collectConfig("tsw");
  var rv = el("tsw-review");
  if (!rv) return;
  var lines = [];
  lines.push("<b>Repo:</b> <code>" + escapeHtml(c.repo) + "</code>" + (c.ghAccount ? " as <code>" + escapeHtml(c.ghAccount) + "</code>" : ""));
  if (c.board && c.board.title) lines.push("<b>Board:</b> " + escapeHtml(c.board.title));
  lines.push("<b>Skip statuses:</b> " + (c.skipStatuses.length ? c.skipStatuses.map(function (s) { return "<code>" + escapeHtml(s) + "</code>"; }).join(", ") : "none"));
  lines.push("<b>Issue type:</b> " + (c.issueType ? escapeHtml(c.issueType) : "any") + " · <b>Assignee:</b> " + escapeHtml(c.assigned));
  if (c.excludeLabels.length) lines.push("<b>Exclude labels:</b> " + c.excludeLabels.map(function (s) { return "<code>" + escapeHtml(s) + "</code>"; }).join(", "));
  lines.push("<b>Recipe:</b> <code>" + escapeHtml(c.recipeId) + "</code>" + (c.createManual ? " (+ manual variant)" : ""));
  var w = c.vendorWeights;
  lines.push("<b>Agents:</b> " + (w.claude || 0) + "% Claude · " + (w.codex || 0) + "% Codex · <b>cron:</b> <code>" + escapeHtml(c.cron) + "</code>");
  lines.push("<b>Auto-launch:</b> " + (c.enabled ? "enabled" : "disabled"));
  rv.innerHTML = lines.join("<br>");
}

function submitScaffold() {
  scaffolding = true;
  updateStep();
  wsSend({ type: "task_setup_scaffold", config: collectConfig("tsw") });
}

function copyWebsitePrompt() {
  var ta = el("tsw-website-prompt");
  if (!ta) return;
  var text = ta.value || "";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast("Prompt copied"); }, function () { fallbackCopy(ta); });
  } else {
    fallbackCopy(ta);
  }
}

function fallbackCopy(ta) {
  ta.removeAttribute("readonly");
  ta.select();
  try { document.execCommand("copy"); showToast("Prompt copied"); } catch (e) {}
  ta.setAttribute("readonly", "readonly");
  window.getSelection().removeAllRanges();
}

// --- Inline section editor -------------------------------------------------

function setInlineStatus(text, isError) {
  var s = el("tsi-status");
  if (!s) return;
  s.textContent = text || "";
  s.classList.toggle("error", !!isError);
}

function saveInline() {
  var cfg = collectConfig("tsi");
  if (!cfg.repo || cfg.repo.split("/").length !== 2) { setInlineStatus("Repo must be owner/name", true); return; }
  if (cfg.cron && cfg.cron.split(/\s+/).length !== 5) { setInlineStatus("Cron must have 5 fields", true); return; }
  setInlineStatus("Saving…");
  wsSend({ type: "task_setup_update", config: cfg });
}

// --- Incoming message handlers --------------------------------------------

export function handleTaskSetupAccounts(msg) {
  var sel = el(activeScope + "-account");
  if (!sel) return;
  var accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
  sel.innerHTML = "";
  var optDefault = document.createElement("option");
  optDefault.value = "";
  optDefault.textContent = "Default (project account)";
  sel.appendChild(optDefault);
  for (var i = 0; i < accounts.length; i++) {
    var o = document.createElement("option");
    o.value = accounts[i];
    o.textContent = accounts[i];
    sel.appendChild(o);
  }
  if (pendingAccount) sel.value = pendingAccount;
  else if (msg.resolved) sel.value = msg.resolved;
  requestRepos();
}

// Drives the Task Launchers section: inline editor when configured, guided
// setup card when not.
export function handleTaskSetupState(msg) {
  activeScope = "tsi";
  var exists = !!(msg && msg.exists);
  var c = (msg && msg.config) || {};
  var inline = el("tsw-inline");
  var promptCard = el("tsw-setup-prompt");
  if (inline) inline.classList.toggle("hidden", !exists);
  if (promptCard) promptCard.classList.toggle("hidden", exists);
  inlineRecipeId = c.recipeId || "assigned-to-me";
  var idLabel = el("tsi-recipe-id-label");
  if (idLabel) idLabel.textContent = inlineRecipeId;
  if (!exists) return;
  savedSkipStatuses = Array.isArray(c.skipStatuses) ? c.skipStatuses.slice() : [];
  savedExcludeLabels = Array.isArray(c.excludeLabels) ? c.excludeLabels.slice() : [];
  pendingAccount = c.ghAccount || "";
  pendingAssigned = c.assigned || "me";
  setVal("tsi-repo", c.repo || "");
  setVal("tsi-recipe-name", c.recipeName || "");
  setVal("tsi-type", c.issueType || "");
  setVal("tsi-title-prefixes", (c.titleExcludePrefixes || []).join(", "));
  setVal("tsi-confidence", c.confidenceThreshold || 80);
  setVal("tsi-dash-port", c.dashboardPort || 8765);
  setVal("tsi-cron", c.cron || "*/5 * * * *");
  setChecked("tsi-enabled", c.enabled);
  setChecked("tsi-create-manual", c.createManual !== false);
  applyVendorPct("tsi", c.vendorWeights);
  buildAssignee("tsi", []);
  setInlineStatus("");
  var accSel = el("tsi-account");
  if (accSel && pendingAccount && accSel.options.length) accSel.value = pendingAccount;
  // Fetch board columns, labels and collaborators for the pickers.
  boardsByScope.tsi = [];
  if (c.repo) wsSend({ type: "task_setup_discover", repo: c.repo, ghAccount: c.ghAccount || "" });
}

export function handleTaskSetupRepos(msg) {
  var list = el(activeScope + "-repo-list");
  if (!list) return;
  var repos = (msg && Array.isArray(msg.repos)) ? msg.repos : [];
  list.innerHTML = "";
  for (var i = 0; i < repos.length; i++) {
    var o = document.createElement("option");
    o.value = repos[i];
    list.appendChild(o);
  }
  if (activeScope === "tsw" && msg && msg.ok && repos.length) {
    setDiscoverStatus(repos.length + " repos available — start typing to filter.");
  }
}

export function handleTaskSetupBoards(msg) {
  awaitingDiscover = false;
  var scope = activeScope;
  if (!msg.ok) {
    if (scope === "tsw") { setDiscoverStatus(msg.error ? ("Discovery failed: " + msg.error) : "Discovery failed.", true); updateStep(); }
    return;
  }
  var boards = Array.isArray(msg.boards) ? msg.boards : [];
  boardsByScope[scope] = boards;
  lastDiscoverKey = (msg.repo || "") + "|" + (msg.account || "");
  var sel = el(scope + "-board");
  if (sel) {
    sel.innerHTML = "";
    if (!boards.length) {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "No project board found";
      sel.appendChild(none);
    } else {
      for (var i = 0; i < boards.length; i++) {
        var o = document.createElement("option");
        o.value = String(i);
        o.textContent = boards[i].title + (boards[i].number ? " (#" + boards[i].number + ")" : "");
        sel.appendChild(o);
      }
    }
  }
  renderStatusList(scope);
  renderLabelList(scope, msg.labels || []);
  buildAssignee(scope, msg.collaborators || []);
  if (scope === "tsw") {
    setDiscoverStatus(boards.length ? (boards.length + " board(s) found.") : "No project board found.");
    var nameEl = el("tsw-recipe-name");
    if (nameEl && !nameEl.value && msg.repo) nameEl.value = "Auto-start issues in " + msg.repo;
    wizardStep = 2;
    updateStep();
  }
}

export function handleTaskSetupResult(msg) {
  // Inline settings save (edit existing setup).
  if (msg && msg.settingsOnly) {
    if (!msg.ok) { setInlineStatus(msg.error ? ("Save failed: " + msg.error) : "Save failed", true); return; }
    setInlineStatus("Saved");
    showToast("Task launcher updated");
    wsSend({ type: "get_auto_launch" });
    loadTaskLauncherSection();
    return;
  }
  // Full scaffold (guided wizard, new project).
  scaffolding = false;
  if (!msg.ok) {
    showToast(msg.error ? ("Setup failed: " + msg.error) : "Setup failed");
    updateStep();
    return;
  }
  var result = el("tsw-result");
  if (result) {
    var html = "<p>Created:</p><ul>";
    var files = Array.isArray(msg.filesWritten) ? msg.filesWritten : [];
    for (var i = 0; i < files.length; i++) html += "<li><code>" + escapeHtml(files[i]) + "</code></li>";
    html += "</ul>";
    if (Array.isArray(msg.warnings) && msg.warnings.length) {
      html += '<p class="ralph-hint" style="margin:6px 0;">' + msg.warnings.map(function (w) { return escapeHtml(w); }).join("<br>") + "</p>";
    }
    if (Array.isArray(msg.manualSteps) && msg.manualSteps.length) {
      html += "<p><b>Next steps:</b></p><ul>";
      for (var k = 0; k < msg.manualSteps.length; k++) html += "<li>" + escapeHtml(msg.manualSteps[k]) + "</li>";
      html += "</ul>";
    }
    result.innerHTML = html;
  }
  var ta = el("tsw-website-prompt");
  if (ta) ta.value = msg.websitePrompt || "";
  wizardStep = LAST_STEP;
  updateStep();
  wsSend({ type: "get_auto_launch" });
  refreshIcons();
}
