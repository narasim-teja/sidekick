import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard.tsx";

/**
 * The dashboard route (`/dashboard`). A thin server-component shell around the client {@link Dashboard},
 * which owns all live data (the engine WS/REST feed + the replay fallback) and the three.js hero. The
 * marketing landing lives at `/`; this is the read-only observability instrument panel it links into.
 */
export const metadata: Metadata = {
  title: "SideKick: Live Venue Instrument Panel",
  description:
    "The per-block loop, made visible: continuous funding, smooth decrement, and the x402 nanopayment settlement stream, live on Arc.",
};

export default function DashboardPage() {
  return <Dashboard />;
}
