/**
 * CLI script to run the scheduled expiry sweep locally.
 * In a real environment, this would be executed by a cron scheduler or worker.
 */

import { runExpirySweep } from "../src/server/subscriptions/expiry-sweep";

async function main() {
  try {
    await runExpirySweep();
    console.log("Sweep finished successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Sweep failed with error:", error);
    process.exit(1);
  }
}

main();