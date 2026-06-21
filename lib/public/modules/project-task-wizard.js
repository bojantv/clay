// project-task-wizard.js - Task Launcher setup wizard (Project Settings →
// Task Launchers). Multi-step modal that discovers a repo's Projects-v2 board
// via gh GraphQL and scaffolds recipes + config + TRIAGE.local.md server-side.
//
// Client ES module. var only, no arrow functions. State via store.js where it
// must outlive the module; transient wizard state is module-local (mirrors
// app-loop-wizard.js). WebSocket via ws-ref.js. Peer functions via direct import.

import { getWs } from './ws-ref.js';
import { refreshIcons } from './icons.js';
import { escapeHtml, showToast } from './utils.js';

var LAST_STEP = 5;

// --- Module-local state ---
var wizardStep = 1;
var boards = [];            // discovered boards
var lastDiscoverKey = "";   // repo|account that boards were fetched for
var awaitingDiscover = false;
var scaffolding = false;
var savedSkipStatuses = []; // skip statuses from existing config, applied after discovery
var pendingAccount = "";    // account from existing config, applied once accounts load

// --- DOM refs (captured in init) ---
var modalEl = null;

function el(id) { return document.getElementById(id); }

function wsSend(obj) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function initTaskWizard() {
  modalEl = el("task-setup-wizard");
  if (!modalEl) return;

  var closeBtn = el("tsw-close");
  var backdrop = modalEl.querySelector(".ralph-wizard-backdrop");
  var backBtn = el("tsw-back");
  var nextBtn = el("tsw-next");
  if (closeBtn) closeBtn.addEventListener("click", closeTaskWizard);
  if (backdrop) backdrop.addEventListener("click", closeTaskWizard);
  if (backBtn) backBtn.addEventListener("click", wizardBack);
  if (nextBtn) nextBtn.addEventListener("click", wizardNext);

  var vendor = el("tsw-vendor");
  if (vendor) vendor.addEventListener("input", updateVendorLabel);

  var account = el("tsw-account");
  if (account) account.addEventListener("change", requestRepos);

  var boardSel = el("tsw-board");
  if (boardSel) boardSel.addEventListener("change", renderStatusList);

  var copyBtn = el("tsw-copy-prompt");
  if (copyBtn) copyBtn.addEventListener("click", copyWebsitePrompt);
}

export function openTaskWizard() {
  if (!modalEl) initTaskWizard();
  if (!modalEl) return;
  wizardStep = 1;
  boards = [];
  lastDiscoverKey = "";
  awaitingDiscover = false;
  scaffolding = false;
  savedSkipStatuses = [];
  pendingAccount = "";
  setDiscoverStatus("");
  updateVendorLabel();
  modalEl.classList.remove("hidden");
  updateStep();
  // Load the existing setup (prefill if configured) and the account dropdown.
  wsSend({ type: "task_setup_state" });
  wsSend({ type: "task_setup_accounts" });
  refreshIcons();
}

export function closeTaskWizard() {
  if (modalEl) modalEl.classList.add("hidden");
  awaitingDiscover = false;
  scaffolding = false;
}

// --- Step navigation -------------------------------------------------------

function updateStep() {
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
  if (key === lastDiscoverKey && boards.length) { wizardStep = 2; updateStep(); return; }
  awaitingDiscover = true;
  setDiscoverStatus("Discovering project board…");
  updateStep();
  wsSend({ type: "task_setup_discover", repo: repo, ghAccount: account });
}

function validateAutomation() {
  var id = (el("tsw-recipe-id").value || "").trim();
  if (!id) { showToast("Recipe id is required"); return false; }
  var cron = (el("tsw-cron").value || "").trim();
  if (cron && cron.split(/\s+/).length !== 5) { showToast("Cron must have 5 fields"); return false; }
  return true;
}

// --- UI helpers ------------------------------------------------------------

function requestRepos() {
  var sel = el("tsw-account");
  wsSend({ type: "task_setup_repos", ghAccount: sel ? sel.value : "" });
}

function setDiscoverStatus(text, isError) {
  var s = el("tsw-discover-status");
  if (!s) return;
  s.textContent = text || "";
  s.style.color = isError ? "var(--danger, #e74c3c)" : "";
}

function updateVendorLabel() {
  var v = el("tsw-vendor");
  var label = el("tsw-vendor-label");
  if (!v || !label) return;
  var claude = parseInt(v.value, 10);
  if (!Number.isFinite(claude)) claude = 70;
  label.textContent = claude + "% Claude · " + (100 - claude) + "% Codex";
}

function vendorWeights() {
  var v = el("tsw-vendor");
  var claude = v ? parseInt(v.value, 10) : 70;
  if (!Number.isFinite(claude)) claude = 70;
  var w = {};
  if (claude > 0) w.claude = claude;
  if (100 - claude > 0) w.codex = 100 - claude;
  return w;
}

function selectedBoard() {
  var sel = el("tsw-board");
  if (!sel) return null;
  var idx = parseInt(sel.value, 10);
  return (Number.isFinite(idx) && boards[idx]) ? boards[idx] : null;
}

// Pre-tick columns that look done-ish so the common case is one click.
function looksDone(name) {
  return /done|complete|ready|closed|shipped|cancel|won't|wont/i.test(String(name || ""));
}

function renderStatusList() {
  var list = el("tsw-status-list");
  if (!list) return;
  var board = selectedBoard();
  var options = (board && Array.isArray(board.options)) ? board.options : [];
  if (!options.length) {
    list.innerHTML = '<div class="ralph-hint" style="margin:0;">No status columns found for this board. You can add skip statuses later in the recipe.</div>';
    return;
  }
  // If editing an existing setup, restore its skip statuses; otherwise
  // pre-tick the columns that look done-ish so the common case is one click.
  var useSaved = savedSkipStatuses.length > 0;
  var html = "";
  for (var i = 0; i < options.length; i++) {
    var name = options[i].name || "";
    var isChecked = useSaved
      ? savedSkipStatuses.indexOf(name) !== -1
      : looksDone(name);
    var checked = isChecked ? " checked" : "";
    html += '<label><input type="checkbox" class="tsw-status-cb" value="' + escapeHtml(name) + '"' + checked + '> ' + escapeHtml(name) + "</label>";
  }
  list.innerHTML = html;
}

function checkedStatuses() {
  var out = [];
  var cbs = modalEl.querySelectorAll(".tsw-status-cb");
  for (var i = 0; i < cbs.length; i++) {
    if (cbs[i].checked) out.push(cbs[i].value);
  }
  return out;
}

function splitCsv(value) {
  return String(value || "").split(",").map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
}

function collectConfig() {
  var repo = (el("tsw-repo").value || "").trim();
  var board = selectedBoard();
  return {
    repo: repo,
    ghAccount: el("tsw-account").value || "",
    recipeId: (el("tsw-recipe-id").value || "").trim(),
    recipeName: (el("tsw-recipe-name").value || "").trim(),
    board: board ? {
      id: board.id, title: board.title, number: board.number,
      statusFieldId: board.statusFieldId, options: board.options,
    } : {},
    skipStatuses: checkedStatuses(),
    includeStatuses: [],
    issueType: el("tsw-type").value || "",
    assigned: el("tsw-assigned").value || "me",
    excludeLabels: splitCsv(el("tsw-exclude-labels").value),
    titleExcludePrefixes: splitCsv(el("tsw-title-prefixes").value),
    vendorWeights: vendorWeights(),
    cron: (el("tsw-cron").value || "").trim() || "*/5 * * * *",
    enabled: !!el("tsw-enabled").checked,
    confidenceThreshold: parseInt(el("tsw-confidence").value, 10) || 80,
    dashboardPort: parseInt(el("tsw-dash-port").value, 10) || 8765,
    createManual: !!el("tsw-create-manual").checked,
    overwriteTriage: !!el("tsw-overwrite-triage").checked,
    fetchLimit: 100,
    defaultLimit: 10,
    environment: "",
  };
}

function renderReview() {
  var c = collectConfig();
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
  wsSend({ type: "task_setup_scaffold", config: collectConfig() });
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

// --- Incoming message handlers --------------------------------------------

export function handleTaskSetupAccounts(msg) {
  var sel = el("tsw-account");
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
  // Now that we know the account, fetch the repos it can access.
  requestRepos();
}

function setVal(id, value) { var e = el(id); if (e != null && value != null) e.value = value; }
function setChecked(id, on) { var e = el(id); if (e) e.checked = !!on; }

export function handleTaskSetupState(msg) {
  var c = (msg && msg.config) || {};
  // Remember values that depend on later async steps.
  savedSkipStatuses = Array.isArray(c.skipStatuses) ? c.skipStatuses.slice() : [];
  pendingAccount = c.ghAccount || "";
  // Prefill the form fields with the current connection.
  setVal("tsw-repo", c.repo || "");
  setVal("tsw-recipe-id", c.recipeId || "assigned-to-me");
  setVal("tsw-recipe-name", c.recipeName || "");
  setVal("tsw-type", c.issueType || "");
  setVal("tsw-assigned", c.assigned || "me");
  setVal("tsw-exclude-labels", (c.excludeLabels || []).join(", "));
  setVal("tsw-title-prefixes", (c.titleExcludePrefixes || []).join(", "));
  setVal("tsw-confidence", c.confidenceThreshold || 80);
  setVal("tsw-dash-port", c.dashboardPort || 8765);
  setVal("tsw-cron", c.cron || "*/5 * * * *");
  setChecked("tsw-enabled", c.enabled);
  setChecked("tsw-create-manual", c.createManual !== false);
  var w = c.vendorWeights || {};
  var claude = parseInt(w.claude, 10);
  var codex = parseInt(w.codex, 10);
  var total = (claude || 0) + (codex || 0);
  var pct = total > 0 ? Math.round(((claude || 0) / total) * 100) : 70;
  var v = el("tsw-vendor");
  if (v) { v.value = pct; updateVendorLabel(); }
  // Reflect create vs edit in the wizard header.
  var hdr = modalEl ? modalEl.querySelector(".ralph-wizard-header span") : null;
  if (hdr) hdr.textContent = msg && msg.exists ? "Edit task launcher" : "Set up task launcher";
}

export function handleTaskSetupRepos(msg) {
  var list = el("tsw-repo-list");
  if (!list) return;
  var repos = (msg && Array.isArray(msg.repos)) ? msg.repos : [];
  list.innerHTML = "";
  for (var i = 0; i < repos.length; i++) {
    var o = document.createElement("option");
    o.value = repos[i];
    list.appendChild(o);
  }
  if (msg && msg.ok && repos.length) setDiscoverStatus(repos.length + " repos available — start typing to filter.");
}

export function handleTaskSetupBoards(msg) {
  awaitingDiscover = false;
  if (!msg.ok) {
    setDiscoverStatus(msg.error ? ("Discovery failed: " + msg.error) : "Discovery failed.", true);
    updateStep();
    return;
  }
  boards = Array.isArray(msg.boards) ? msg.boards : [];
  lastDiscoverKey = (msg.repo || "") + "|" + (msg.account || "");
  var sel = el("tsw-board");
  if (sel) {
    sel.innerHTML = "";
    if (!boards.length) {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "No project board found (skip statuses can be added later)";
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
  renderStatusList();
  setDiscoverStatus(boards.length ? (boards.length + " board(s) found.") : "No project board found.");
  // Prefill recipe name if empty.
  var nameEl = el("tsw-recipe-name");
  if (nameEl && !nameEl.value && msg.repo) nameEl.value = "Auto-start issues in " + msg.repo;
  wizardStep = 2;
  updateStep();
}

export function handleTaskSetupResult(msg) {
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
  // Refresh the Automation panel so the new recipe / state shows up.
  wsSend({ type: "get_auto_launch" });
  refreshIcons();
}
