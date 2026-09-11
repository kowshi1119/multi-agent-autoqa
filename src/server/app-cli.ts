import "dotenv/config";
import { isMainModule } from "../main-module-guard.js";
import { startServer } from "./app.js";

async function main(): Promise<void> {
  const { port } = await startServer({ port: 4180 });
  console.log("AutoQA control panel\n");
  console.log(`Open: http://localhost:${port}\n`);
  console.log("Press Ctrl+C to stop.");
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("AutoQA UI server encountered an unexpected error:");
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
