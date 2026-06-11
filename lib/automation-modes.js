var AUTOMATION_MODES = {
  ASK: "ask",
  AUTO: "auto",
  FULL: "full",
  CUSTOM: "custom",
};

function normalizeAutomationMode(mode) {
  if (mode === AUTOMATION_MODES.ASK) return AUTOMATION_MODES.ASK;
  if (mode === AUTOMATION_MODES.AUTO) return AUTOMATION_MODES.AUTO;
  if (mode === AUTOMATION_MODES.FULL) return AUTOMATION_MODES.FULL;
  if (mode === AUTOMATION_MODES.CUSTOM) return AUTOMATION_MODES.CUSTOM;
  return AUTOMATION_MODES.ASK;
}

function claudePermissionForAutomation(mode) {
  var normalized = normalizeAutomationMode(mode);
  if (normalized === AUTOMATION_MODES.AUTO) return "acceptEdits";
  if (normalized === AUTOMATION_MODES.FULL) return "bypassPermissions";
  return "default";
}

function automationForClaudePermission(mode) {
  if (mode === "acceptEdits") return AUTOMATION_MODES.AUTO;
  if (mode === "bypassPermissions") return AUTOMATION_MODES.FULL;
  if (mode === "default") return AUTOMATION_MODES.ASK;
  return AUTOMATION_MODES.CUSTOM;
}

function codexConfigForAutomation(mode) {
  var normalized = normalizeAutomationMode(mode);
  if (normalized === AUTOMATION_MODES.FULL) {
    return { approval: "never", sandbox: "danger-full-access" };
  }
  if (normalized === AUTOMATION_MODES.AUTO) {
    return { approval: "never", sandbox: "workspace-write" };
  }
  return { approval: "on-request", sandbox: "workspace-write" };
}

function automationForCodexConfig(approval, sandbox) {
  if (approval === "never" && sandbox === "danger-full-access") return AUTOMATION_MODES.FULL;
  if (approval === "never" && sandbox === "workspace-write") return AUTOMATION_MODES.AUTO;
  if (approval === "on-request" && sandbox === "workspace-write") return AUTOMATION_MODES.ASK;
  return AUTOMATION_MODES.CUSTOM;
}

function automationForSession(session, fallbackMode, fallbackCodexConfig) {
  if (session && session.automationMode) return normalizeAutomationMode(session.automationMode);
  if (session && session.vendor === "codex") {
    var codexConfig = fallbackCodexConfig || {};
    var approval = session.codexApproval || codexConfig.approval;
    var sandbox = session.codexSandbox || codexConfig.sandbox;
    return automationForCodexConfig(approval, sandbox);
  }
  return automationForClaudePermission((session && session.permissionMode) || fallbackMode || "default");
}

module.exports = {
  AUTOMATION_MODES: AUTOMATION_MODES,
  normalizeAutomationMode: normalizeAutomationMode,
  claudePermissionForAutomation: claudePermissionForAutomation,
  automationForClaudePermission: automationForClaudePermission,
  codexConfigForAutomation: codexConfigForAutomation,
  automationForCodexConfig: automationForCodexConfig,
  automationForSession: automationForSession,
};
