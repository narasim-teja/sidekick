/** The short agent — the balancing baseline directional participant (Doc 2 §4.1). `bun run agent:short`. */
import { runOne } from "../run-one.ts";

runOne("short").catch((err) => {
  console.error("agent:short fatal:", err);
  process.exit(1);
});
