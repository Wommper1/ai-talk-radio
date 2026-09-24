export function missingModels(configured: readonly string[], available: readonly string[]): string[] {
  const known = new Set(available.map((id) => id.trim()).filter(Boolean));
  return Array.from(new Set(configured.map((id) => id.trim()).filter(Boolean))).filter((id) => !known.has(id));
}
