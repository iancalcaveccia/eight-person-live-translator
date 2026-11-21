/** Stable avatar colour for someone who has no seat colour (home screen lists). */
export function colorFor(id: string): string {
  return `var(--c${parseInt(id.replace(/-/g, "").slice(0, 6), 16) % 8})`;
}
