/** The funding-strategy agent (HERO) — holds ~pure funding exposure (Doc 2 §4.1, Doc 3 §11). `bun run agent:funding`. */
import { runOne } from "../run-one.ts";

runOne("funding").catch((err) => {
  console.error("agent:funding fatal:", err);
  process.exit(1);
});
