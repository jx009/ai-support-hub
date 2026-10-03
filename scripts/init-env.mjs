import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const hex = () => randomBytes(32).toString("hex");
let content = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
for (const key of [
  "POSTGRES_PASSWORD",
  "MASTER_KEY",
  "ADMIN_TOKEN",
  "CHATWOOT_SECRET_KEY_BASE",
  "CHATWOOT_DB_PASSWORD",
  "CHATWOOT_REDIS_PASSWORD",
]) {
  content = content.replace(
    new RegExp("^" + key + "=.*$", "m"),
    key + "=" + hex(),
  );
}
const arg = process.argv.find((a) => a.startsWith("--public-url="));
if (arg) {
  const url = new URL(arg.slice("--public-url=".length));
  content = content.replace(/^PUBLIC_URL=.*$/m, "PUBLIC_URL=" + url.origin);
}
await writeFile(new URL("../.env", import.meta.url), content, {
  flag: "wx",
  mode: 0o600,
});
console.log(
  ".env created. Edit domains and image settings. Existing .env files are never overwritten.",
);
