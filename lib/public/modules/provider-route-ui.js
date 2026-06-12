export function providerAvatar(vendor, routeId) {
  if (routeId === "claude-anthropic" || routeId === "claude-github-copilot") return "/claude-code-avatar.png";
  if (routeId === "codex-openai" || routeId === "codex-github-copilot") return "/codex-avatar.png";
  if (vendor === "codex" || vendor === "github-copilot") return "/codex-avatar.png";
  return "/claude-code-avatar.png";
}

export function providerShortName(vendor, routeId) {
  if (routeId === "claude-anthropic" || routeId === "claude-github-copilot") return "Claude";
  if (routeId === "codex-openai" || routeId === "codex-github-copilot") return "Codex";
  if (vendor === "github-copilot") return "GitHub Copilot";
  if (vendor === "codex") return "Codex";
  return "Claude";
}
