"use client";

/**
 * InstallConsole: the developer on-ramp, styled as a terminal window. Package-manager tabs
 * (npm / pnpm / bun / yarn) swap the install command; a click-to-copy button puts it on the
 * clipboard. The package name is the real one the SDK publishes under (`@sidekick/sdk`).
 *
 * Keyboard-accessible: the tab strip is a roving radio group (arrow keys move, Enter/Space select),
 * the copy button is a real <button>. The blinking caret is purely decorative and stops under
 * prefers-reduced-motion (handled in globals.css).
 */

import { useId, useState } from "react";

const PKG = "@sidekick/sdk";

const MANAGERS = [
  { id: "npm", cmd: `npm i ${PKG}` },
  { id: "pnpm", cmd: `pnpm add ${PKG}` },
  { id: "bun", cmd: `bun add ${PKG}` },
  { id: "yarn", cmd: `yarn add ${PKG}` },
] as const;

type ManagerId = (typeof MANAGERS)[number]["id"];

export function InstallConsole() {
  const [active, setActive] = useState<ManagerId>("bun");
  const [copied, setCopied] = useState(false);
  const groupId = useId();

  const current = MANAGERS.find((m) => m.id === active) ?? MANAGERS[0];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (insecure context / headless), the command is selectable anyway */
    }
  };

  // Roving arrow-key navigation across the tab strip.
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = (i + (e.key === "ArrowRight" ? 1 : MANAGERS.length - 1)) % MANAGERS.length;
      const target = MANAGERS[next];
      if (!target) return;
      setActive(target.id);
      document.getElementById(`${groupId}-${next}`)?.focus();
    }
  };

  return (
    <div className="console w-full max-w-xl">
      {/* chrome + tabs */}
      <div className="console-chrome justify-between">
        <div className="flex items-center gap-2">
          <span className="console-dot" style={{ background: "var(--danger)" }} />
          <span className="console-dot" style={{ background: "var(--warn)" }} />
          <span className="console-dot" style={{ background: "var(--signal)" }} />
          <span className="ml-2 text-[10px] tracking-[0.2em] uppercase text-[var(--fg-dim)]">
            add the venue to your agent
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="package manager"
          className="flex items-center gap-0.5"
        >
          {MANAGERS.map((m, i) => (
            <button
              type="button"
              key={m.id}
              id={`${groupId}-${i}`}
              role="radio"
              aria-checked={m.id === active}
              tabIndex={m.id === active ? 0 : -1}
              data-active={m.id === active}
              className="pm-tab"
              onClick={() => setActive(m.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {m.id}
            </button>
          ))}
        </div>
      </div>

      {/* command line */}
      <div className="flex items-center justify-between gap-3 px-4 py-4">
        <code className="font-mono text-[13px] sm:text-[14px] text-[var(--fg)] truncate">
          <span className="text-[var(--signal)] select-none mr-1.5">$</span>
          {current.cmd}
          <span className="caret" aria-hidden="true" />
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 text-[11px] tracking-wide px-2.5 py-1.5 rounded border border-[var(--line-bright)] text-[var(--fg-mid)] hover:text-[var(--fg)] hover:border-[var(--fg-mid)] transition-colors"
          aria-live="polite"
        >
          {copied ? (
            <span style={{ color: "var(--signal)" }}>✓ copied</span>
          ) : (
            <span>copy</span>
          )}
        </button>
      </div>

      {/* the immediate next step, what they do after install */}
      <div className="px-4 pb-4 pt-1 border-t border-[var(--line)] text-[11px] text-[var(--fg-dim)] font-mono leading-relaxed">
        <span className="text-[var(--fg-mid)]">import</span> {"{ SideKick }"}{" "}
        <span className="text-[var(--fg-mid)]">from</span>{" "}
        <span className="text-[var(--accent-funding)]">&quot;@sidekick/sdk&quot;</span>
        <br />
        <span className="text-[var(--fg-dim)]">
          {"// discover → onboard → open → answer calls every block"}
        </span>
      </div>
    </div>
  );
}
