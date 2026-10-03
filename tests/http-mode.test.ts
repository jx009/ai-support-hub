import { afterEach, expect, test, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { configSchema } from "../src/config.js";
import type { Database } from "../src/db.js";
import { requestKey } from "../web/request-key.js";

afterEach(() => vi.unstubAllGlobals());

test.each(["http", "https"])("%s public URL sets appropriate HTTPS headers", async (protocol) => {
  const config = configSchema.parse({
    DATABASE_URL: "postgresql://unused/support_test",
    MASTER_KEY: "a".repeat(64),
    ADMIN_TOKEN: "b".repeat(32),
    PUBLIC_URL: `${protocol}://192.0.2.1:6001`,
  });
  const db = { query: async () => [] } as unknown as Database;
  const server = createApp(db, config).app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")?.includes("upgrade-insecure-requests")).toBe(protocol === "https");
    expect(response.headers.has("strict-transport-security")).toBe(protocol === "https");
    expect(await response.json()).toEqual({ ok: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("request keys work without the HTTPS-only randomUUID browser API", () => {
  vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const keys = Array.from({ length: 100 }, () => requestKey());
  expect(new Set(keys).size).toBe(100);
  for (const key of keys) {
    expect(key).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  }
});
