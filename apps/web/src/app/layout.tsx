import type { Metadata, Viewport } from "next";
import { Chakra_Petch, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/*
 * Distinctive type pairing (not Inter/Roboto): Chakra Petch, a squared, technical display face that
 * reads like instrument labelling, for headings; IBM Plex Mono for every readout, so numbers carry
 * the precise, machine-room character the venue is about. Loaded as CSS variables the theme consumes.
 */
const display = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-chakra",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SideKick: The Perp Venue Built for Agents",
  description:
    "Per-block continuous funding. No liquidations, your position decrements smoothly. Gas-free nanopayment settlement on Arc. The venue for agent-native strategies human perps make impossible.",
};

export const viewport: Viewport = {
  themeColor: "#07090c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body
        style={{
          // Wire the loaded fonts into the theme's --font-display / --font-mono.
          ["--font-display" as string]: "var(--font-chakra), ui-sans-serif, sans-serif",
          ["--font-mono" as string]: "var(--font-plex-mono), ui-monospace, monospace",
        }}
      >
        {children}
      </body>
    </html>
  );
}
