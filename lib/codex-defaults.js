var CODEX_DEFAULTS = {
  approval: "on-failure",
  sandbox: "danger-full-access",
  webSearch: "live",
};

function getCodexConfig(sm, session) {
  return {
    approval: (session && session.codexApproval) || (sm && sm.codexApproval) || CODEX_DEFAULTS.approval,
    sandbox: (session && session.codexSandbox) || (sm && sm.codexSandbox) || CODEX_DEFAULTS.sandbox,
    webSearch: (session && session.codexWebSearch) || (sm && sm.codexWebSearch) || CODEX_DEFAULTS.webSearch,
  };
}

module.exports = {
  CODEX_DEFAULTS: CODEX_DEFAULTS,
  getCodexConfig: getCodexConfig,
};
