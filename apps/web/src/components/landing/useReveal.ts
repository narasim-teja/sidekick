"use client";

/**
 * useReveal — a tiny scroll-reveal hook. Content is visible by default (CSS `.reveal` is a no-op); we
 * only ARM the entrance (hide + offset) on the client AFTER mount, then play it when the element scrolls
 * into view via IntersectionObserver. So a headless render / disabled-JS / tab-throttled context never
 * ships blank — the reveal is pure enhancement over an already-visible default (per the skill's rule).
 *
 * Respects prefers-reduced-motion: when reduced, we never arm, so the content simply stays put.
 */

import { useEffect, useRef } from "react";

export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduce =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return; // leave content visible, no entrance

    // Arm: hide + offset, now that we know JS + motion are available.
    el.classList.add("armed");

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);

    return () => io.disconnect();
  }, []);

  return ref;
}
