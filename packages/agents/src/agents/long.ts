/** The long agent — a baseline healthy directional participant (Doc 2 §4.1). `bun run agent:long`. */
import { runOne } from "../run-one.ts";

runOne("long").catch((err) => {
  console.error("agent:long fatal:", err);
  process.exit(1);
});
