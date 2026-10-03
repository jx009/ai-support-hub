import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Config } from "./config.js";
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
  ) {
    super(message);
  }
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function hash(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
export function sign(
  method: string,
  path: string,
  time: string,
  nonce: string,
  body: string,
  secret: string,
) {
  return crypto
    .createHmac("sha256", secret)
    .update([method.toUpperCase(), path, time, nonce, hash(body)].join("\n"))
    .digest("hex");
}
export function seal(value: string, key: string) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal(value: string, key: string) {
  const [iv, tag, data] = value
    .split(".")
    .map((s) => Buffer.from(s, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
export type Session = {
  pid: string;
  uid: string;
  name: string;
  email: string;
  origin: string;
  version: number;
};
const tokenKey = (c: Config) =>
  crypto
    .createHmac("sha256", Buffer.from(c.MASTER_KEY, "hex"))
    .update("support-session-v1")
    .digest();
export function issueSession(s: Session, c: Config) {
  return jwt.sign(s, tokenKey(c), {
    algorithm: "HS256",
    expiresIn: 900,
    issuer: "support-hub",
    audience: "support-widget",
  });
}
export function verifySession(t: string, c: Config): Session {
  try {
    return jwt.verify(t, tokenKey(c), {
      algorithms: ["HS256"],
      issuer: "support-hub",
      audience: "support-widget",
    }) as Session;
  } catch {
    throw new AppError(401, "客服会话已过期，请重新连接", "SESSION_EXPIRED");
  }
}
export function validateUrl(value: string, c: Config) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["http:", "https:"].includes(u.protocol)
  )
    throw new AppError(400, "服务地址格式错误");
  if (u.protocol !== "https:" && c.ALLOW_HTTP_UPSTREAMS !== "true")
    throw new AppError(400, "服务地址必须使用 HTTPS");
  return value.replace(/\/+$/, "");
}
