var ROUTES = [
  {
    id: "claude-anthropic",
    vendor: "claude",
    provider: "anthropic",
    modelFamily: "claude",
    label: "Claude via Anthropic",
    description: "Use your Claude subscription directly.",
    executable: true,
  },
  {
    id: "codex-openai",
    vendor: "codex",
    provider: "openai",
    modelFamily: "gpt",
    label: "Codex via OpenAI",
    description: "Use your ChatGPT/OpenAI Codex session.",
    executable: true,
  },
  {
    id: "claude-github-copilot",
    vendor: "github-copilot",
    provider: "github-copilot",
    modelFamily: "claude",
    label: "Claude via GitHub Copilot",
    description: "Fallback route for Claude-family models through GitHub Copilot CLI.",
    executable: true,
    defaultModel: "claude-opus-4.8",
    setup: "GitHub Copilot CLI is not installed. Install it with npm install -g @github/copilot, then run copilot login.",
  },
  {
    id: "codex-github-copilot",
    vendor: "github-copilot",
    provider: "github-copilot",
    modelFamily: "gpt",
    label: "Codex via GitHub Copilot",
    description: "Fallback route for Codex/GPT coding models through GitHub Copilot CLI.",
    executable: true,
    defaultModel: "gpt-5.5",
    setup: "GitHub Copilot CLI is not installed. Install it with npm install -g @github/copilot, then run copilot login.",
  },
];

var PROVIDER_MODELS = {
  "github-copilot": [
    "auto",
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "claude-fable-5",
    "claude-opus-4.8",
    "claude-opus-4.7",
    "claude-opus-4.6",
    "claude-opus-4.6-fast",
    "claude-opus-4.5",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.4-mini",
    "gpt-5-mini",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
  ],
};

function cloneRoute(route) {
  return Object.assign({}, route);
}

function listProviderRoutes(availableVendors, installedVendors) {
  var available = availableVendors || [];
  var installed = installedVendors || [];
  var result = [];
  for (var i = 0; i < ROUTES.length; i++) {
    var route = cloneRoute(ROUTES[i]);
    route.available = route.executable && available.indexOf(route.vendor) !== -1;
    route.installed = route.executable ? installed.indexOf(route.vendor) !== -1 : false;
    route.enabled = !!(route.available && route.installed);
    result.push(route);
  }
  return result;
}

function routeForVendor(vendor) {
  for (var i = 0; i < ROUTES.length; i++) {
    if (ROUTES[i].vendor === vendor && ROUTES[i].executable) return cloneRoute(ROUTES[i]);
  }
  return null;
}

function routeForId(id) {
  for (var i = 0; i < ROUTES.length; i++) {
    if (ROUTES[i].id === id) return cloneRoute(ROUTES[i]);
  }
  return null;
}

function knownModelsForProvider(provider) {
  var models = PROVIDER_MODELS[provider] || [];
  return models.slice();
}

function modelMatchesFamily(model, family) {
  if (!model || !family) return true;
  if (family === "claude") return model.indexOf("claude-") === 0;
  if (family === "gpt") return model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1;
  return true;
}

function knownModelsForRoute(route) {
  if (!route || !route.provider) return [];
  var models = knownModelsForProvider(route.provider);
  if (!route.modelFamily) return models;
  var result = [];
  for (var i = 0; i < models.length; i++) {
    if (modelMatchesFamily(models[i], route.modelFamily)) result.push(models[i]);
  }
  return result;
}

module.exports = {
  listProviderRoutes: listProviderRoutes,
  routeForId: routeForId,
  routeForVendor: routeForVendor,
  knownModelsForProvider: knownModelsForProvider,
  knownModelsForRoute: knownModelsForRoute,
};
