import { Dashboard } from "@/components/Dashboard.tsx";

/**
 * The dashboard route. A thin server-component shell around the client {@link Dashboard}, which owns
 * all live data (the engine WS/REST feed + the replay fallback) and the three.js hero.
 */
export default function Page() {
  return <Dashboard />;
}
