/** The market-maker agent — takes the balancing side so skew self-corrects (Doc 2 §4.1). `bun run agent:mm`. */
import { runOne } from "../run-one.ts";

runOne("mm").catch((err) => {
  console.error("agent:mm fatal:", err);
  process.exit(1);
});
