// server-settings.js — Full-screen server settings overlay
import { refreshIcons } from './icons.js';
import { showToast, copyToClipboard } from './utils.js';
import { parseEnvString, looksLikeEnv } from './project-settings.js';
import { checkAdminAccess, loadAdminSection } from './admin.js';
import { closeFileViewer } from './filebrowser.js';
import { renderModelList, renderModeList, renderEffortBar, renderThinkingBar, renderBetaCard, isSonnetModel, renderOptionList, CODEX_APPROVAL_OPTIONS, CODEX_SANDBOX_OPTIONS, CODEX_WEBSEARCH_OPTIONS } from './settings-defaults.js';

var ctx = null;
var settingsEl = null;
var settingsBtn = null;
var closeBtn = null;
var navItems = null;
var sections = null;
var statsTimer = null;
var defaultsVendor = "claude";
var settingsModelInfoByVendor = {};
var VENDOR_SETUP = {
  claude: {
    label: "Claude via Anthropic",
    cli: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    login: "claude login",
    description: "Uses Claude Code auth, Anthropic API keys, Bedrock, or Vertex credentials from the server environment.",
  },
  codex: {
    label: "Codex via OpenAI",
    cli: "codex",
    install: "npm install -g @openai/codex",
    login: "codex login --device-auth",
    description: "Uses Codex CLI auth for your ChatGPT/OpenAI account.",
  },
  "github-copilot": {
    label: "GitHub Copilot CLI",
    cli: "copilot",
    install: "npm install -g @github/copilot",
    login: "copilot login",
    description: "Uses GitHub Copilot CLI for Claude-family and Codex/GPT-family fallback routes. VS Code sign-in alone is not enough for Clay.",
  },
};

export function initServerSettings(appCtx) {
  ctx = appCtx;
  settingsEl = document.getElementById("server-settings");
  settingsBtn = document.getElementById("server-settings-btn");
  closeBtn = document.getElementById("server-settings-close");

  if (!settingsEl || !settingsBtn) return;

  navItems = settingsEl.querySelectorAll(".settings-nav-item");
  sections = settingsEl.querySelectorAll(".server-settings-section");

  // Open settings
  settingsBtn.addEventListener("click", function () {
    openSettings();
  });

  // Close settings
  closeBtn.addEventListener("click", function () {
    closeSettings();
  });

  // ESC to close
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !settingsEl.classList.contains("hidden")) {
      closeSettings();
    }
  });

  // Nav item clicks
  for (var i = 0; i < navItems.length; i++) {
    navItems[i].addEventListener("click", function () {
      var section = this.dataset.section;
      switchSection(section);
    });
  }

  var vendorTabs = settingsEl.querySelectorAll(".ps-vendor-tab");
  for (var vt = 0; vt < vendorTabs.length; vt++) {
    vendorTabs[vt].addEventListener("click", function () {
      defaultsVendor = this.dataset.vendor || "claude";
      switchDefaultsVendor(defaultsVendor);
    });
  }

  // Mobile dropdown nav
  var navDropdown = document.getElementById("settings-nav-dropdown");
  if (navDropdown) {
    navDropdown.addEventListener("change", function () {
      switchSection(this.value);
    });
  }

  // Copyable command blocks
  var copyables = settingsEl.querySelectorAll(".settings-copyable");
  for (var c = 0; c < copyables.length; c++) {
    copyables[c].addEventListener("click", function () {
      var text = this.dataset.copy;
      if (!text) return;
      var btn = this.querySelector(".settings-copy-btn");
      copyToClipboard(text).then(function () {
        if (btn) {
          var orig = btn.textContent;
          btn.textContent = "✓";
          setTimeout(function () { btn.textContent = orig; }, 1500);
        }
        showToast("Copied to clipboard");
      });
    });
  }

  var vendorList = document.getElementById("settings-vendor-list");
  if (vendorList) {
    vendorList.addEventListener("click", function (e) {
      var btn = e.target.closest(".settings-vendor-copy");
      if (!btn) return;
      var text = btn.dataset.copy;
      if (!text) return;
      copyToClipboard(text).then(function () {
        var orig = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = orig; }, 1500);
        showToast("Copied to clipboard");
      });
    });
  }
  var vendorRefresh = document.getElementById("settings-vendors-refresh");
  if (vendorRefresh) {
    vendorRefresh.addEventListener("click", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        vendorRefresh.disabled = true;
        vendorRefresh.textContent = "Refreshing...";
        ws.send(JSON.stringify({ type: "refresh_vendors" }));
        setTimeout(function () {
          vendorRefresh.disabled = false;
          vendorRefresh.textContent = "Refresh vendors";
        }, 1500);
      }
    });
  }

  // Notification toggles
  var notifAlert = document.getElementById("settings-notif-alert");
  var notifSound = document.getElementById("settings-notif-sound");
  var notifPush = document.getElementById("settings-notif-push");

  if (notifAlert) {
    notifAlert.addEventListener("change", function () {
      var src = document.getElementById("notif-toggle-alert");
      if (src) {
        src.checked = this.checked;
        src.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  if (notifSound) {
    notifSound.addEventListener("change", function () {
      var src = document.getElementById("notif-toggle-sound");
      if (src) {
        src.checked = this.checked;
        src.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  if (notifPush) {
    notifPush.addEventListener("change", function () {
      var src = document.getElementById("notif-toggle-push");
      if (src) {
        src.checked = this.checked;
        src.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  // PIN buttons
  var pinSetBtn = document.getElementById("settings-pin-set-btn");
  var pinRemoveBtn = document.getElementById("settings-pin-remove-btn");
  var pinSaveBtn = document.getElementById("settings-pin-save-btn");
  var pinCancelBtn = document.getElementById("settings-pin-cancel-btn");
  var pinInput = document.getElementById("settings-pin-input");

  if (pinSetBtn) pinSetBtn.addEventListener("click", function () { showPinForm(); });
  if (pinRemoveBtn) pinRemoveBtn.addEventListener("click", function () {
    var ws = ctx.ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "set_pin", pin: null }));
    }
  });
  if (pinSaveBtn) pinSaveBtn.addEventListener("click", function () { submitPin(); });
  if (pinCancelBtn) pinCancelBtn.addEventListener("click", function () { hidePinForm(); });
  if (pinInput) pinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitPin(); }
    if (e.key === "Escape") { e.preventDefault(); hidePinForm(); }
  });

  // Auto-continue moved to User Settings > Behavior

  // Keep awake toggle
  var keepAwakeToggle = document.getElementById("settings-keep-awake");
  if (keepAwakeToggle) {
    keepAwakeToggle.addEventListener("change", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "set_keep_awake", value: this.checked }));
      }
    });
  }

  // Image retention select
  var imageRetentionSelect = document.getElementById("settings-image-retention");
  if (imageRetentionSelect) {
    imageRetentionSelect.addEventListener("change", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "set_image_retention", days: parseInt(this.value, 10) }));
      }
    });
  }

  // Global CLAUDE.md: save button
  var ssClaudeMdSave = document.getElementById("ss-claudemd-save");
  if (ssClaudeMdSave) {
    ssClaudeMdSave.addEventListener("click", function () { saveGlobalClaudeMd(); });
  }

  // Shared environment: add button
  var ssEnvAddBtn = document.getElementById("ss-env-add-btn");
  if (ssEnvAddBtn) {
    ssEnvAddBtn.addEventListener("click", function () {
      addSharedEnvRow("", "", true);
      autoSaveSharedEnv();
    });
  }

  // Restart server
  var restartBtn = document.getElementById("settings-restart-btn");
  if (restartBtn) {
    restartBtn.addEventListener("click", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        restartBtn.disabled = true;
        restartBtn.textContent = "Restarting...";
        ws.send(JSON.stringify({ type: "restart_server" }));
      }
    });
  }

  // Shutdown server
  var shutdownInput = document.getElementById("settings-shutdown-input");
  var shutdownBtn = document.getElementById("settings-shutdown-btn");

  if (shutdownInput && shutdownBtn) {
    shutdownInput.addEventListener("input", function () {
      var val = this.value.trim().toLowerCase();
      shutdownBtn.disabled = val !== "shutdown";
    });

    shutdownInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!shutdownBtn.disabled) shutdownBtn.click();
      }
    });

    shutdownBtn.addEventListener("click", function () {
      var val = shutdownInput.value.trim().toLowerCase();
      if (val !== "shutdown") return;
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        shutdownBtn.disabled = true;
        shutdownBtn.textContent = "Shutting down...";
        shutdownInput.disabled = true;
        ws.send(JSON.stringify({ type: "shutdown_server" }));
      }
    });
  }
}

function switchSection(sectionName) {
  for (var i = 0; i < navItems.length; i++) {
    var isActive = navItems[i].dataset.section === sectionName;
    navItems[i].classList.toggle("active", isActive);
  }
  // Sync mobile dropdown
  var navDropdown = document.getElementById("settings-nav-dropdown");
  if (navDropdown && navDropdown.value !== sectionName) {
    navDropdown.value = sectionName;
  }
  for (var j = 0; j < sections.length; j++) {
    var isActive2 = sections[j].dataset.section === sectionName;
    sections[j].classList.toggle("active", isActive2);
  }

  // Lazy-load section data
  if (sectionName === "claudemd") loadGlobalClaudeMd();
  if (sectionName === "environment") loadSharedEnv();
  if (sectionName === "vendors") renderVendorSetup();
  if (sectionName === "admin-users" || sectionName === "admin-invites" || sectionName === "admin-projects" || sectionName === "admin-smtp") {
    var adminBody = document.getElementById(sectionName + "-body");
    if (adminBody) loadAdminSection(sectionName, adminBody);
  }
}

function openSettings() {
  closeFileViewer();
  settingsEl.classList.remove("hidden");
  settingsBtn.classList.add("active");
  refreshIcons(settingsEl);
  populateSettings();
  requestDaemonConfig();
  resetRestartButton();
  resetShutdownForm();

  // Show/hide admin sections based on role
  checkAdminAccess().then(function (isAdmin) {
    var adminEls = settingsEl.querySelectorAll(".settings-admin-only");
    for (var ai = 0; ai < adminEls.length; ai++) {
      adminEls[ai].style.display = isAdmin ? "" : "none";
    }
  });

  // Start periodic stats refresh
  requestStats();
  statsTimer = setInterval(requestStats, 5000);
}

function resetRestartButton() {
  var btn = document.getElementById("settings-restart-btn");
  var errorEl = document.getElementById("settings-restart-error");
  if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px;"></i>Restart'; }
  if (errorEl) errorEl.classList.add("hidden");
}

function resetShutdownForm() {
  var input = document.getElementById("settings-shutdown-input");
  var btn = document.getElementById("settings-shutdown-btn");
  var errorEl = document.getElementById("settings-shutdown-error");
  if (input) { input.value = ""; input.disabled = false; }
  if (btn) { btn.disabled = true; btn.textContent = "Shutdown"; }
  if (errorEl) errorEl.classList.add("hidden");
}

function closeSettings() {
  settingsEl.classList.add("hidden");
  settingsBtn.classList.remove("active");
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

export function isSettingsOpen() {
  return settingsEl && !settingsEl.classList.contains("hidden");
}

function requestStats() {
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "process_stats" }));
  }
}

function populateSettings() {
  var nameEl = document.getElementById("settings-server-name");
  var versionEl = document.getElementById("settings-server-version");
  var slugEl = document.getElementById("settings-project-slug");
  var wsPathEl = document.getElementById("settings-ws-path");

  // Nav header defaults to hostname (updated by updateDaemonConfig)
  if (nameEl && !nameEl.textContent) nameEl.textContent = "Server";

  // Version is set from WebSocket "info" message in app.js
  if (versionEl && !versionEl.textContent) versionEl.textContent = "-";

  if (slugEl) slugEl.textContent = ctx.currentSlug || "(default)";
  if (wsPathEl) wsPathEl.textContent = ctx.wsPath || "/ws";

  // Sync notification toggles
  syncNotifToggles();
  renderVendorSetup();

  switchDefaultsVendor(defaultsVendor || "claude");
}

function vendorStatusBadge(route, installed) {
  if (route && route.enabled) return '<span class="settings-badge settings-badge-green">Ready</span>';
  if (installed) return '<span class="settings-badge">Installed</span>';
  return '<span class="settings-badge settings-badge-off">Missing CLI</span>';
}

function setupForVendor(vendor) {
  return VENDOR_SETUP[vendor] || {
    label: vendor,
    cli: vendor,
    install: "",
    login: vendor + " login",
    description: "Uses a vendor command-line tool installed on this server.",
  };
}

function routeByVendor(routes, vendor) {
  for (var i = 0; i < routes.length; i++) {
    if (routes[i] && routes[i].vendor === vendor) return routes[i];
  }
  return null;
}

function renderCommandButton(label, command) {
  if (!command) return "";
  return '<button type="button" class="settings-vendor-copy" data-copy="' + escapeAttr(command) + '">' +
    '<span>' + label + '</span><code>' + escapeHtml(command) + '</code>' +
    '</button>';
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function renderVendorSetup() {
  var list = document.getElementById("settings-vendor-list");
  if (!list) return;
  var installed = ctx.installedVendors || [];
  var routes = ctx.providerRoutes || [];
  var vendors = ["claude", "codex", "github-copilot"];
  var html = "";
  for (var i = 0; i < vendors.length; i++) {
    var vendor = vendors[i];
    var setup = setupForVendor(vendor);
    var route = routeByVendor(routes, vendor);
    var isInstalled = installed.indexOf(vendor) !== -1;
    var statusText = route && route.enabled
      ? "Clay can use this route."
      : (isInstalled ? "CLI found. Run the login command if this vendor asks for authentication." : "Install the CLI, then run the login command.");
    if (route && route.setup && !route.enabled) statusText = route.setup;
    html += '<div class="settings-card settings-vendor-card">' +
      '<div class="settings-vendor-head">' +
      '<div><div class="settings-vendor-title">' + escapeHtml(setup.label) + '</div>' +
      '<div class="settings-hint">' + escapeHtml(setup.description) + '</div></div>' +
      vendorStatusBadge(route, isInstalled) +
      '</div>' +
      '<div class="settings-vendor-meta">' +
      '<span>CLI: <code>' + escapeHtml(setup.cli) + '</code></span>' +
      '<span>' + escapeHtml(statusText) + '</span>' +
      '</div>' +
      '<div class="settings-vendor-actions">' +
      renderCommandButton("Install", setup.install) +
      renderCommandButton("Login", setup.login) +
      '</div>' +
      '</div>';
  }
  html += '<div class="settings-card settings-vendor-note">' +
    '<div class="settings-field">' +
    '<label class="settings-label">How Clay uses vendors</label>' +
    '<div class="settings-hint">Clay reads vendor binaries and credentials from this server user account. If Clay runs under another OS user, install and log in under that same user. After installing a new CLI, restart Clay so the adapter is loaded.</div>' +
    '</div>' +
    '</div>';
  list.innerHTML = html;
}

function syncNotifToggles() {
  var pairs = [
    ["notif-toggle-alert", "settings-notif-alert"],
    ["notif-toggle-sound", "settings-notif-sound"],
    ["notif-toggle-push", "settings-notif-push"],
  ];
  for (var i = 0; i < pairs.length; i++) {
    var src = document.getElementById(pairs[i][0]);
    var dst = document.getElementById(pairs[i][1]);
    if (src && dst) dst.checked = src.checked;
  }
}

function ssSendMsg(type, data) {
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    var msg = Object.assign({ type: type }, data);
    ws.send(JSON.stringify(msg));
  }
}

function ssDefaultsOpts() {
  var modelInfo = settingsModelInfoByVendor[defaultsVendor] || {};
  var fallbackModels = ctx.modelsByVendor && ctx.modelsByVendor[defaultsVendor] ? ctx.modelsByVendor[defaultsVendor] : [];
  if (fallbackModels.length === 0 && (ctx.currentVendor || "claude") === defaultsVendor) fallbackModels = ctx.currentModels || [];
  var fullAuto = !!ctx.fullAutoMode;
  var forceClaudeBypass = defaultsVendor === "claude" && fullAuto;
  var mode = forceClaudeBypass ? "bypassPermissions" : (ctx.currentMode || "default");
  return {
    models: modelInfo.models || fallbackModels,
    currentModel: modelInfo.model || ctx.currentModel || ctx._currentModelValue || "",
    currentMode: mode,
    currentEffort: ctx.currentEffort || "medium",
    currentThinking: ctx.currentThinking || "adaptive",
    currentThinkingBudget: ctx.currentThinkingBudget || 10000,
    currentBetas: ctx.currentBetas || [],
    vendor: defaultsVendor,
    readOnlyMode: forceClaudeBypass,
    sendMsg: ssSendMsg,
    modelMsgType: "set_server_default_model",
    modeMsgType: "set_server_default_mode",
    effortMsgType: "set_server_default_effort",
    onModelSelect: function (model) {
      if (defaultsVendor === "claude") updateSsBetaCard(model);
    },
  };
}

function requestDefaultsVendorModels(vendor) {
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "get_vendor_models", vendor: vendor }));
  }
}

function switchDefaultsVendor(vendor) {
  defaultsVendor = vendor === "codex" ? "codex" : "claude";
  var tabs = settingsEl ? settingsEl.querySelectorAll(".server-settings-section[data-section=\"defaults\"] .ps-vendor-tab") : [];
  var panels = settingsEl ? settingsEl.querySelectorAll(".server-settings-section[data-section=\"defaults\"] .ps-vendor-panel") : [];
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle("active", tabs[i].dataset.vendor === defaultsVendor);
  }
  for (var j = 0; j < panels.length; j++) {
    panels[j].classList.toggle("active", panels[j].dataset.vendorPanel === defaultsVendor);
  }
  requestDefaultsVendorModels(defaultsVendor);
  if (defaultsVendor === "claude") renderClaudeDefaults();
  else renderCodexDefaults();
}

function renderClaudeDefaults() {
  var opts = ssDefaultsOpts();
  renderModelList("ss-claude", opts);
  renderBetaCard("ss-claude", opts);
  renderModeList("ss", opts);
  renderEffortBar("ss", opts);
}

function sendServerCodexDefaults(overrides) {
  if (ctx.fullAutoMode && (overrides.approval || overrides.sandbox)) return;
  var approval = ctx.codexApproval || "on-failure";
  var sandbox = ctx.codexSandbox || "danger-full-access";
  var webSearch = ctx.codexWebSearch || "live";
  if (overrides.approval) approval = overrides.approval;
  if (overrides.sandbox) sandbox = overrides.sandbox;
  if (overrides.webSearch) webSearch = overrides.webSearch;
  ctx.codexApproval = approval;
  ctx.codexSandbox = sandbox;
  ctx.codexWebSearch = webSearch;
  ssSendMsg("set_server_default_codex_config", {
    approval: approval,
    sandbox: sandbox,
    webSearch: webSearch,
  });
}

function renderCodexDefaults() {
  var opts = ssDefaultsOpts();
  var fullAuto = !!ctx.fullAutoMode;
  var approval = fullAuto ? "never" : (ctx.codexApproval || "on-failure");
  var sandbox = fullAuto ? "danger-full-access" : (ctx.codexSandbox || "danger-full-access");
  renderModelList("ss-codex", opts);
  renderOptionList("ss-codex-approval-list", CODEX_APPROVAL_OPTIONS, approval, function (value) {
    sendServerCodexDefaults({ approval: value });
    renderCodexDefaults();
  }, fullAuto);
  renderOptionList("ss-codex-sandbox-list", CODEX_SANDBOX_OPTIONS, sandbox, function (value) {
    sendServerCodexDefaults({ sandbox: value });
    renderCodexDefaults();
  }, fullAuto);
  renderOptionList("ss-codex-websearch-list", CODEX_WEBSEARCH_OPTIONS, ctx.codexWebSearch || "live", function (value) {
    sendServerCodexDefaults({ webSearch: value });
    renderCodexDefaults();
  });
  renderEffortBar("ss-codex", opts);
}

function updateThinkingBar() {
  renderThinkingBar("ss", ssDefaultsOpts());
}

function updateSsBetaCard(overrideModel) {
  renderBetaCard("ss-claude", Object.assign(ssDefaultsOpts(), { overrideModel: overrideModel }));
}

export function handleSettingsModels(vendor, model, models) {
  if (!vendor) return;
  if (model && typeof model === "object") model = model.value || model.id || model.name || model.displayName || "";
  settingsModelInfoByVendor[vendor] = {
    model: model || "",
    models: models || [],
  };
  if (isSettingsOpen()) renderVendorSetup();
  if (!isSettingsOpen() || defaultsVendor !== vendor) return;
  if (vendor === "claude") renderClaudeDefaults();
  else renderCodexDefaults();
}

export function updateSettingsStats(data) {
  if (!isSettingsOpen()) return;
  var pid = document.getElementById("settings-status-pid");
  var uptime = document.getElementById("settings-status-uptime");
  var rss = document.getElementById("settings-status-rss");
  var sessions = document.getElementById("settings-status-sessions");
  var clients = document.getElementById("settings-status-clients");

  if (pid) pid.textContent = String(data.pid);
  if (uptime) uptime.textContent = formatUptime(data.uptime);
  if (rss) rss.textContent = formatBytes(data.memory.rss);
  if (sessions) sessions.textContent = String(data.sessions);
  if (clients) clients.textContent = String(data.clients);
}

export function updateSettingsModels(current, models) {
  if (!ctx) return;
  ctx.currentModels = models;
  ctx._currentModelValue = current;
  if (isSettingsOpen()) {
    renderVendorSetup();
    if (defaultsVendor === "claude") renderClaudeDefaults();
    else renderCodexDefaults();
  }
}

// --- Daemon config ---
function requestDaemonConfig() {
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "get_daemon_config" }));
  }
}

export function updateDaemonConfig(config) {
  // Nav header: show hostname (strip .local suffix, lowercase)
  var nameEl = document.getElementById("settings-server-name");
  if (nameEl && config.hostname) {
    var displayHost = config.hostname.replace(/\.local$/i, "").toLowerCase();
    nameEl.textContent = displayHost;
    nameEl.title = config.hostname;
  }

  // Host
  var hostnameEl = document.getElementById("settings-hostname");
  var lanIpEl = document.getElementById("settings-lan-ip");
  if (hostnameEl) hostnameEl.textContent = config.hostname || "-";
  if (lanIpEl) lanIpEl.textContent = config.lanIp || "";

  // Port
  var portEl = document.getElementById("settings-port");
  if (portEl) portEl.textContent = String(config.port || "-");

  // TLS
  var tlsEl = document.getElementById("settings-tls");
  if (tlsEl) {
    tlsEl.textContent = config.tls ? "Enabled" : "Disabled";
    tlsEl.classList.toggle("settings-badge-green", !!config.tls);
  }

  // Debug
  var debugEl = document.getElementById("settings-debug");
  if (debugEl) {
    debugEl.textContent = config.debug ? "Enabled" : "Disabled";
    debugEl.classList.toggle("settings-badge-on", !!config.debug);
  }

  // PIN status
  updatePinStatus(!!config.pinEnabled);

  // Auto-continue on rate limit
  // Auto-continue is now per-user (User Settings > Behavior)

  // Keep awake
  var keepAwakeToggle = document.getElementById("settings-keep-awake");
  if (keepAwakeToggle) keepAwakeToggle.checked = !!config.keepAwake;

  // Image retention
  var imageRetentionSelect = document.getElementById("settings-image-retention");
  if (imageRetentionSelect && config.imageRetentionDays !== undefined) {
    imageRetentionSelect.value = String(config.imageRetentionDays);
  }

  // Early Access toggle
  var channelToggle = document.getElementById("settings-update-channel");
  if (channelToggle) {
    channelToggle.checked = (config.updateChannel === "beta");
    channelToggle.onchange = function () {
      var channel = channelToggle.checked ? "beta" : "stable";
      if (ctx.ws && ctx.ws.readyState === 1) {
        ctx.ws.send(JSON.stringify({ type: "set_update_channel", channel: channel }));
        // Auto-trigger update check after channel change
        setTimeout(function () {
          ctx.ws.send(JSON.stringify({ type: "check_update" }));
        }, 200);
      }
    };
  }

  // Show keep awake section/nav only on macOS
  var keepAwakeSection = document.getElementById("settings-keep-awake-section");
  var keepAwakeNav = document.getElementById("settings-keep-awake-nav");
  var keepAwakeOpt = document.getElementById("settings-keep-awake-opt");
  if (config.platform === "darwin") {
    if (keepAwakeSection) keepAwakeSection.classList.remove("hidden");
    if (keepAwakeNav) keepAwakeNav.classList.remove("hidden");
    if (keepAwakeOpt) keepAwakeOpt.classList.remove("hidden");
  } else {
    if (keepAwakeSection) keepAwakeSection.classList.add("hidden");
    if (keepAwakeNav) keepAwakeNav.classList.add("hidden");
    if (keepAwakeOpt) keepAwakeOpt.classList.add("hidden");
  }
}

export function handleSetPinResult(msg) {
  if (msg.ok) {
    updatePinStatus(!!msg.pinEnabled);
    hidePinForm();
    showToast(msg.pinEnabled ? "PIN set successfully" : "PIN removed");
  }
}

export function handleKeepAwakeChanged(msg) {
  var keepAwakeToggle = document.getElementById("settings-keep-awake");
  if (keepAwakeToggle) keepAwakeToggle.checked = !!msg.keepAwake;
}

export function handleAutoContinueChanged(msg) {
  // Auto-continue is now per-user; server broadcast no longer updates UI
}

export function handleRestartResult(msg) {
  var restartBtn = document.getElementById("settings-restart-btn");
  var errorEl = document.getElementById("settings-restart-error");

  if (msg.ok) {
    if (restartBtn) restartBtn.textContent = "Server restarting...";
    showToast("Server is restarting...");
  } else {
    if (restartBtn) {
      restartBtn.textContent = "Restart";
      restartBtn.disabled = false;
    }
    if (errorEl) {
      errorEl.textContent = msg.error || "Restart failed";
      errorEl.classList.remove("hidden");
    }
  }
}

export function handleShutdownResult(msg) {
  var shutdownInput = document.getElementById("settings-shutdown-input");
  var shutdownBtn = document.getElementById("settings-shutdown-btn");
  var errorEl = document.getElementById("settings-shutdown-error");

  if (msg.ok) {
    if (shutdownBtn) shutdownBtn.textContent = "Server stopped";
    showToast("Server is shutting down...");
  } else {
    if (shutdownBtn) {
      shutdownBtn.textContent = "Shutdown";
      shutdownBtn.disabled = false;
    }
    if (shutdownInput) shutdownInput.disabled = false;
    if (errorEl) {
      errorEl.textContent = msg.error || "Shutdown failed";
      errorEl.classList.remove("hidden");
    }
  }
}

// --- PIN form management ---
function showPinForm() {
  var form = document.getElementById("settings-pin-form");
  var input = document.getElementById("settings-pin-input");
  var errorEl = document.getElementById("settings-pin-error");
  if (form) form.classList.remove("hidden");
  if (errorEl) errorEl.classList.add("hidden");
  if (input) { input.value = ""; input.focus(); }
}

function hidePinForm() {
  var form = document.getElementById("settings-pin-form");
  var input = document.getElementById("settings-pin-input");
  var errorEl = document.getElementById("settings-pin-error");
  if (form) form.classList.add("hidden");
  if (input) input.value = "";
  if (errorEl) errorEl.classList.add("hidden");
}

function submitPin() {
  var input = document.getElementById("settings-pin-input");
  var errorEl = document.getElementById("settings-pin-error");
  if (!input) return;
  var pin = input.value.trim();
  if (!/^\d{6}$/.test(pin)) {
    if (errorEl) errorEl.classList.remove("hidden");
    input.focus();
    return;
  }
  if (errorEl) errorEl.classList.add("hidden");
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "set_pin", pin: pin }));
  }
}

function updatePinStatus(enabled) {
  var statusEl = document.getElementById("settings-pin-status");
  var setBtn = document.getElementById("settings-pin-set-btn");
  var removeBtn = document.getElementById("settings-pin-remove-btn");
  var actionLabel = document.getElementById("settings-pin-action-label");

  if (statusEl) {
    statusEl.textContent = enabled ? "Enabled" : "Disabled";
    statusEl.classList.toggle("settings-badge-green", enabled);
  }
  if (setBtn) setBtn.textContent = enabled ? "Change PIN" : "Set PIN";
  if (removeBtn) removeBtn.classList.toggle("hidden", !enabled);
  if (actionLabel) actionLabel.textContent = enabled ? "Change PIN" : "Set PIN";
}

// ===== Global CLAUDE.md =====
function loadGlobalClaudeMd() {
  var editor = document.getElementById("ss-claudemd-editor");
  var status = document.getElementById("ss-claudemd-status");
  var saveStatus = document.getElementById("ss-claudemd-save-status");
  if (saveStatus) saveStatus.textContent = "";
  if (status) status.textContent = "Loading...";

  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "read_global_claude_md" }));
  }
}

export function handleGlobalClaudeMdRead(msg) {
  var editor = document.getElementById("ss-claudemd-editor");
  var status = document.getElementById("ss-claudemd-status");
  if (!editor) return;

  if (msg.error) {
    editor.value = "";
    if (status) status.textContent = "No global instructions file found. Save to create one.";
  } else {
    editor.value = msg.content || "";
    if (status) status.textContent = "";
  }
}

function saveGlobalClaudeMd() {
  var editor = document.getElementById("ss-claudemd-editor");
  var saveStatus = document.getElementById("ss-claudemd-save-status");
  if (!editor) return;

  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "write_global_claude_md", content: editor.value }));
    if (saveStatus) saveStatus.textContent = "Saving...";
  }
}

export function handleGlobalClaudeMdWrite(msg) {
  var saveStatus = document.getElementById("ss-claudemd-save-status");
  if (!saveStatus) return;
  if (msg.ok) {
    saveStatus.textContent = "Saved";
    setTimeout(function () { saveStatus.textContent = ""; }, 2000);
  } else {
    saveStatus.textContent = "Error: " + (msg.error || "Failed to save");
  }
}

// ===== Shared Environment Variables =====
var sharedEnvSaveTimer = null;

function loadSharedEnv() {
  var saveStatus = document.getElementById("ss-env-save-status");
  if (saveStatus) saveStatus.textContent = "";

  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "get_shared_env" }));
  }
}

export function handleSharedEnv(msg) {
  var list = document.getElementById("ss-env-list");
  if (!list) return;
  list.innerHTML = "";

  var pairs = parseEnvString(msg.envrc || "");
  for (var i = 0; i < pairs.length; i++) {
    addSharedEnvRow(pairs[i].key, pairs[i].value, false);
  }
  refreshIcons();
}

export function handleSharedEnvSaved(msg) {
  var saveStatus = document.getElementById("ss-env-save-status");
  if (!saveStatus) return;
  if (msg.ok) {
    saveStatus.textContent = "Saved";
    setTimeout(function () { saveStatus.textContent = ""; }, 2000);
  } else {
    saveStatus.textContent = "Error: " + (msg.error || "Failed to save");
  }
}

function buildSharedEnvString() {
  var list = document.getElementById("ss-env-list");
  if (!list) return "";
  var rows = list.querySelectorAll(".ps-env-row");
  var lines = [];
  for (var i = 0; i < rows.length; i++) {
    var keyInput = rows[i].querySelector(".ps-env-key");
    var valInput = rows[i].querySelector(".ps-env-val");
    var key = keyInput ? keyInput.value.trim() : "";
    var val = valInput ? valInput.value : "";
    if (key) lines.push("export " + key + "=" + val);
  }
  return lines.join("\n");
}

function addSharedEnvRow(key, value, focus) {
  var list = document.getElementById("ss-env-list");
  if (!list) return;

  var row = document.createElement("div");
  row.className = "ps-env-row";

  var keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.className = "ps-env-key";
  keyInput.placeholder = "KEY";
  keyInput.value = key;
  keyInput.spellcheck = false;
  keyInput.autocomplete = "off";

  var valInput = document.createElement("input");
  valInput.type = "text";
  valInput.className = "ps-env-val";
  valInput.placeholder = "value";
  valInput.value = value;
  valInput.spellcheck = false;
  valInput.autocomplete = "off";

  var delBtn = document.createElement("button");
  delBtn.className = "ps-env-del";
  delBtn.title = "Remove";
  delBtn.innerHTML = '<i data-lucide="x"></i>';

  delBtn.addEventListener("click", function () {
    row.remove();
    autoSaveSharedEnv();
  });

  keyInput.addEventListener("input", function () { autoSaveSharedEnv(); });
  valInput.addEventListener("input", function () { autoSaveSharedEnv(); });

  // Paste detection
  keyInput.addEventListener("paste", function (e) {
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (text && looksLikeEnv(text)) {
      e.preventDefault();
      var pairs = parseEnvString(text);
      if (pairs.length > 0) {
        keyInput.value = pairs[0].key;
        valInput.value = pairs[0].value;
        for (var p = 1; p < pairs.length; p++) {
          addSharedEnvRow(pairs[p].key, pairs[p].value, false);
        }
        autoSaveSharedEnv();
      }
    }
  });

  valInput.addEventListener("paste", function (e) {
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (text && text.indexOf("\n") !== -1 && text.indexOf("=") !== -1) {
      e.preventDefault();
      var pairs = parseEnvString(text);
      if (pairs.length > 0) {
        keyInput.value = pairs[0].key;
        valInput.value = pairs[0].value;
        for (var p = 1; p < pairs.length; p++) {
          addSharedEnvRow(pairs[p].key, pairs[p].value, false);
        }
        autoSaveSharedEnv();
      }
    }
  });

  row.appendChild(keyInput);
  row.appendChild(valInput);
  row.appendChild(delBtn);
  list.appendChild(row);
  refreshIcons();

  if (focus) keyInput.focus();
}

function autoSaveSharedEnv() {
  if (sharedEnvSaveTimer) clearTimeout(sharedEnvSaveTimer);
  sharedEnvSaveTimer = setTimeout(function () {
    var envrc = buildSharedEnvString();
    var ws = ctx.ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "set_shared_env", envrc: envrc }));
      var saveStatus = document.getElementById("ss-env-save-status");
      if (saveStatus) {
        saveStatus.textContent = "Saved";
        setTimeout(function () { saveStatus.textContent = ""; }, 2000);
      }
    }
  }, 800);
}

function formatBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function formatUptime(seconds) {
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (d > 0) return d + "d " + h + "h " + m + "m";
  if (h > 0) return h + "h " + m + "m " + s + "s";
  return m + "m " + s + "s";
}
