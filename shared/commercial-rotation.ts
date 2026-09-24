export function uniqueByCopy<T extends { text: string }>(spots: readonly T[]): T[] {
  const seen = new Set<string>();
  return spots.filter((spot) => {
    const copy = spot.text.trim().toLowerCase().replace(/\s+/g, " ");
    if (!copy || seen.has(copy)) return false;
    seen.add(copy);
    return true;
  });
}

export function preferDistinctCopy<T extends { text: string }>(spots: readonly T[], wanted: number): T[] {
  const distinct = uniqueByCopy(spots);
  if (distinct.length >= wanted) return distinct.slice(0, wanted);
  const chosen = new Set(distinct);
  return [...distinct, ...spots.filter((spot) => !chosen.has(spot))].slice(0, wanted);
}

/** Split a flat rotation pick into the exact commercial load for each break. */
export function groupCommercialBreaks<T>(spots: readonly T[], breaks: number, spotsPerBreak: number): T[][] {
  const breakCount = Math.max(0, Math.floor(breaks));
  const perBreak = Math.max(0, Math.floor(spotsPerBreak));
  return Array.from({ length: breakCount }, (_, index) =>
    spots.slice(index * perBreak, (index + 1) * perBreak),
  );
}
