import { startAuthFixtureServer } from "./auth-server.js";

const port = Number(process.env["AUTH_FIXTURE_PORT"] ?? 4175);
const server = await startAuthFixtureServer({ port });
console.log(`Synthetic authenticated fixture listening on ${server.origin}`);
console.log("Seeded synthetic accounts: demo-a / demo-a-synthetic-password, demo-b / demo-b-synthetic-password");
console.log("Press Ctrl+C to stop.");
