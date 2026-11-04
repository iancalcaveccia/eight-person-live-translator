import { ImageResponse } from "next/og";

/** PNG app icons for the web manifest (192 / 512), generated at request time and cached. */
export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size: raw } = await ctx.params;
  const size = raw === "512" ? 512 : 192;
  const glyph = Math.round(size * 0.5);
  return new ImageResponse(
    (
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(140deg, #e8774f, #f2b25c)",
        }}
      >
        <svg width={glyph} height={glyph} viewBox="0 0 48 48">
          <path
            d="M8 10.5C8 8.6 9.6 7 11.5 7h17C30.4 7 32 8.6 32 10.5v10c0 1.9-1.6 3.5-3.5 3.5H17l-6.2 5.1c-.7.6-1.8.1-1.8-.8V24C8.4 23.4 8 22 8 20.5v-10Z"
            fill="#1b0f09"
            fillOpacity="0.92"
          />
          <path
            d="M40 22.5c0-1.9-1.6-3.5-3.5-3.5H35v2.5c0 3.6-2.9 6.5-6.5 6.5H20v2.5c0 1.9 1.6 3.5 3.5 3.5H31l6.2 5.1c.7.6 1.8.1 1.8-.8V36c.6-.6 1-1.5 1-2.5v-11Z"
            fill="#1b0f09"
            fillOpacity="0.55"
          />
        </svg>
      </div>
    ),
    { width: size, height: size, headers: { "cache-control": "public, max-age=86400, immutable" } },
  );
}
