function modelFamily(model) {
  if (!model) return "";
  if (model.indexOf("claude-") === 0) return "claude";
  if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "codex";
  return "";
}

export function providerAvatar(vendor, routeId, model) {
  var family = modelFamily(model);
  if (vendor === "github-copilot" && family === "claude") return "/claude-code-avatar.png";
  if (vendor === "github-copilot" && family === "codex") return "/codex-avatar.png";
  if (routeId === "claude-anthropic" || routeId === "claude-github-copilot") return "/claude-code-avatar.png";
  if (routeId === "codex-openai" || routeId === "codex-github-copilot") return "/codex-avatar.png";
  if (vendor === "codex" || vendor === "github-copilot") return "/codex-avatar.png";
  return "/claude-code-avatar.png";
}

export function providerShortName(vendor, routeId, model) {
  var family = modelFamily(model);
  if (vendor === "github-copilot" && family === "claude") return "Claude";
  if (vendor === "github-copilot" && family === "codex") return "Codex";
  if (routeId === "claude-anthropic" || routeId === "claude-github-copilot") return "Claude";
  if (routeId === "codex-openai" || routeId === "codex-github-copilot") return "Codex";
  if (vendor === "github-copilot") return "GitHub Copilot";
  if (vendor === "codex") return "Codex";
  return "Claude";
}
