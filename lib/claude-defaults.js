var CLAUDE_FALLBACK_MODELS = [
  {
    value: "default",
    displayName: "Default",
    description: "Recommended model for your account.",
  },
  {
    value: "best",
    displayName: "Best available",
    description: "Uses Fable 5 where available, otherwise the latest Opus.",
  },
  {
    value: "fable",
    displayName: "Fable 5",
    description: "For your toughest challenges.",
  },
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "For complex tasks.",
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Most efficient for everyday tasks.",
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "Fastest for quick answers.",
  },
  {
    value: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Older Opus model with xhigh as its default effort.",
  },
  {
    value: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Previous Opus model for complex tasks.",
  },
];

function cloneModel(model) {
  var out = {};
  for (var key in model) out[key] = model[key];
  return out;
}

function fallbackClaudeModels() {
  var out = [];
  for (var i = 0; i < CLAUDE_FALLBACK_MODELS.length; i++) {
    out.push(cloneModel(CLAUDE_FALLBACK_MODELS[i]));
  }
  return out;
}

function modelValue(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.id || model.name || "";
}

function hasConcreteClaudeModel(models) {
  if (!Array.isArray(models)) return false;
  for (var i = 0; i < models.length; i++) {
    if (modelValue(models[i]).indexOf("claude-") === 0) return true;
  }
  return false;
}

function withClaudeFallbackModels(models) {
  if (!Array.isArray(models) || models.length === 0) return fallbackClaudeModels();
  if (!hasConcreteClaudeModel(models)) return fallbackClaudeModels();

  var out = models.slice();
  var seen = {};
  for (var i = 0; i < out.length; i++) {
    var existing = modelValue(out[i]);
    if (existing) seen[existing] = true;
  }
  for (var j = 0; j < CLAUDE_FALLBACK_MODELS.length; j++) {
    var fallback = CLAUDE_FALLBACK_MODELS[j];
    if (!seen[fallback.value]) out.push(cloneModel(fallback));
  }
  return out;
}

module.exports = {
  CLAUDE_FALLBACK_MODELS: CLAUDE_FALLBACK_MODELS,
  fallbackClaudeModels: fallbackClaudeModels,
  withClaudeFallbackModels: withClaudeFallbackModels,
};
