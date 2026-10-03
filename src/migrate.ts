import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { readConfig } from "./config.js";
import { Database } from "./db.js";
export async function migrate(db: Database) {
  const sql = await readFile(
    path.resolve("migrations/001_initial.sql"),
    "utf8",
  );
  await db.lock("support:migrations", async (client) => {
    await client.query(sql);
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const db = new Database(readConfig().DATABASE_URL);
  await migrate(db);
  await db.close();
  console.log("Support database ready.");
}
