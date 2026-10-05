/**
 * Format a USD spend for display. Positive amounts use four decimals, except those that would
 * round to "$0.0000": those are bounded as "<$0.0001" so a real cost never reads as free.
 * Non-positive amounts produce no reading, so callers can leave a zero cost off the line.
 */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";
  const fixed = cost.toFixed(4);
  return fixed === "0.0000" ? "<$0.0001" : `~$${fixed}`;
}
