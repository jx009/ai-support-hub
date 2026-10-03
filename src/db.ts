import pg, { type PoolClient } from "pg";
import { AppError } from "./security.js";
import { AsyncLocalStorage } from "node:async_hooks";
export class Database {
  readonly pool: pg.Pool;
  private readonly scope = new AsyncLocalStorage<PoolClient>();
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 16 });
  }
  async query(text: string, values: unknown[] = []) {
    return (this.scope.getStore() || this.pool).query(text, values);
  }
  async one<T = any>(
    text: string,
    values: unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.query(text, values)).rows[0];
  }
  async lock<T>(
    key: string,
    fn: (client: PoolClient) => Promise<T>,
    tryOnly = false,
  ): Promise<T | undefined> {
    const existing = this.scope.getStore(),
      client = existing || (await this.pool.connect());
    let locked = false;
    try {
      locked = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
          [key],
        )
      ).rows[0].ok;
      if (!locked) {
        if (tryOnly) return;
        throw new AppError(409, "该操作正在处理中，请稍后重试", "BUSY");
      }
      return await this.scope.run(client, () => fn(client));
    } finally {
      if (locked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [key],
        );
      if (!existing) client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
