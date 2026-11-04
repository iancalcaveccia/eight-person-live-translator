/** Two overlapping speech bubbles: two languages meeting at one table. */
export function BrandGlyph({ size = 34, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <path
        d="M8 10.5C8 8.6 9.6 7 11.5 7h17C30.4 7 32 8.6 32 10.5v10c0 1.9-1.6 3.5-3.5 3.5H17l-6.2 5.1c-.7.6-1.8.1-1.8-.8V24h-.0C8.4 23.4 8 22 8 20.5v-10Z"
        fill={color}
        opacity="0.92"
      />
      <path
        d="M40 22.5c0-1.9-1.6-3.5-3.5-3.5H35v2.5c0 3.6-2.9 6.5-6.5 6.5H20v2.5c0 1.9 1.6 3.5 3.5 3.5H31l6.2 5.1c.7.6 1.8.1 1.8-.8V36c.6-.6 1-1.5 1-2.5v-11Z"
        fill={color}
        opacity="0.55"
      />
    </svg>
  );
}
