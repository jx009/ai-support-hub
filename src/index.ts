import { readConfig } from "./config.js";
import { Database } from "./db.js";
import { createApp } from "./app.js";
import { Worker } from "./worker.js";
const config = readConfig(),
  db = new Database(config.DATABASE_URL);
await db.query("SELECT version FROM support_schema_versions LIMIT 1");
const { app, projects } = createApp(db, config);
const worker = new Worker(db, projects);
worker.start();
const server = app.listen(config.PORT, "0.0.0.0", () =>
  console.log("AI Support Hub listening on port " + config.PORT),
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([closed, worker.close()]);
  await db.close();
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
