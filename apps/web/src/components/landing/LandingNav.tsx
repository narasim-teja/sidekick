"use client";

/**
 * LandingNav — the sticky masthead for the marketing page. Carries the wordmark, a small set of
 * in-page anchors, a "testnet · Arc" provenance chip (honest about what's live), and the primary
 * CTA — "Enter the venue ↗" — which is the whole point of the page: send a developer/judge into the
 * live `/dashboard` instrument panel. Becomes a frosted hairline bar once the user scrolls past the
 * hero fold.
 */

import { useEffect, useState } from "react";

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="fixed top-0 inset-x-0 z-40 transition-colors duration-300"
      style={{
        background: scrolled ? "rgba(7,9,12,0.78)" : "transparent",
        backdropFilter: scrolled ? "blur(12px)" : "none",
        borderBottom: scrolled ? "1px solid var(--line)" : "1px solid transparent",
      }}
    >
      <nav className="mx-auto max-w-[1480px] px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <a href="#top" className="flex items-center gap-2.5 group" aria-label="SideKick home">
          <Mark />
          <span className="font-display font-bold text-lg leading-none tracking-tight">
            SIDE<span style={{ color: "var(--signal)" }}>KICK</span>
          </span>
        </a>

        <div className="hidden md:flex items-center gap-7 text-[12px] text-[var(--fg-mid)]">
          <a className="hover:text-[var(--fg)] transition-colors" href="#thesis">
            Thesis
          </a>
          <a className="hover:text-[var(--fg)] transition-colors" href="#mechanism">
            Mechanism
          </a>
          <a className="hover:text-[var(--fg)] transition-colors" href="#sdk">
            SDK
          </a>
          <a className="hover:text-[var(--fg)] transition-colors" href="#stack">
            Stack
          </a>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] tracking-[0.15em] uppercase text-[var(--fg-dim)]">
            <span
              className="pulse w-1.5 h-1.5 rounded-full"
              style={{ background: "var(--signal)", color: "var(--signal)" }}
            />
            testnet · Arc
          </span>
          <a href="/dashboard" className="btn-key">
            Enter the venue
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </nav>
    </header>
  );
}

/** The concentric-tick mark — echoes the dashboard logo / the pool ring. */
function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r="15" fill="none" stroke="var(--line-bright)" strokeWidth="1" />
      <circle cx="17" cy="17" r="4.5" fill="var(--signal)" />
      {Array.from({ length: 12 }, (_, i) => i).map((i) => {
        const a = (i / 12) * Math.PI * 2;
        return (
          <line
            key={`m-${i}`}
            x1={17 + Math.cos(a) * 9}
            y1={17 + Math.sin(a) * 9}
            x2={17 + Math.cos(a) * 12.5}
            y2={17 + Math.sin(a) * 12.5}
            stroke="var(--signal-dim)"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}
