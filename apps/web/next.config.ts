import type { NextConfig } from "next";

/**
 * The dashboard is a pure client of the engine's REST + WebSocket surface, so it ships as a fully
 * static export — no Next server, no API routes, deployable to any static host (Vercel, a CDN, or
 * `bunx serve out/`). All live data arrives over the browser `fetch`/`WebSocket` at runtime from
 * `NEXT_PUBLIC_ENGINE_URL` (defaults to http://localhost:8787). When the engine is unreachable the
 * client falls back to a bundled deterministic demo replay, so a cold URL is never blank.
 */
const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  // three.js ships ESM; nothing to transpile, but keep images unoptimized for the static export.
  images: { unoptimized: true },
};

export default config;
