import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { configSchema } from '../src/config.js';
import { jsonRequest } from '../src/providers.js';

test('AI deadline defaults to ten minutes, accepts deployment strings and rejects larger values', () => {
  const base = {
    DATABASE_URL: 'postgresql://unused/support_test',
    MASTER_KEY: 'a'.repeat(64), ADMIN_TOKEN: 'b'.repeat(32),
    PUBLIC_URL: 'https://support.example.com',
  };
  expect(configSchema.parse(base).AI_TIMEOUT_MS).toBe(600000);
  expect(configSchema.parse({ ...base, AI_TIMEOUT_MS: '600000' }).AI_TIMEOUT_MS).toBe(600000);
  expect(configSchema.parse({ ...base, AI_TIMEOUT_MS: '120000' }).AI_TIMEOUT_MS).toBe(120000);
  expect(configSchema.safeParse({ ...base, AI_TIMEOUT_MS: '600001' }).success).toBe(false);
});

test('upstream requests wait for delayed headers and enforce a deadline while reading the body', async () => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    if (req.url === '/body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    }, 150);
    timers.add(timer);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await expect(jsonRequest(url, {}, 'GET', undefined, 600000)).resolves.toEqual({ ok: true });
    await expect(jsonRequest(url, {}, 'GET', undefined, 30)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await expect(jsonRequest(url + '/body', {}, 'GET', undefined, 50)).rejects.toThrow();
  } finally {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
