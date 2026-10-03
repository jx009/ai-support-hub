import "dotenv/config";
import { z } from "zod";
export const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  MASTER_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  ADMIN_TOKEN: z.string().min(32),
  PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4080),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  ALLOW_HTTP_UPSTREAMS: z.enum(["true", "false"]).default("false"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(600000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config {
  return configSchema.parse(process.env);
}
