/** The dark agent — goes silent to demonstrate smooth decrement, not liquidation (Doc 2 §4.1, Doc 3 §11). `bun run agent:dark`. */
import { runOne } from "../run-one.ts";

runOne("dark").catch((err) => {
  console.error("agent:dark fatal:", err);
  process.exit(1);
});
