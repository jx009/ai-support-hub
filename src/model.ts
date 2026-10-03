import { z } from "zod";
export const settingsSchema = z.object({
  chatwootUrl: z.string().url(),
  accountId: z.number().int().positive(),
  inboxId: z.number().int().positive(),
  chatwootToken: z.string().min(1).max(1000),
  botId: z.number().int().positive().optional(),
  maxkbUrl: z.string().url(),
  maxkbKey: z.string().min(1).max(1000),
  model: z.string().max(100).default("maxkb"),
  origins: z
    .array(
      z
        .string()
        .url()
        .refine((v) => new URL(v).origin === v, "只填写 origin，不含路径"),
    )
    .min(1)
    .max(30),
  welcome: z
    .string()
    .max(1000)
    .default("你好，我是 AI 客服。可以先问我，未解决的问题可提交工单。"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#4f46e5"),
  questions: z
    .array(
      z.object({
        id: z.string().max(64),
        question: z.string().min(1).max(300),
        enabled: z.boolean().default(true),
      }),
    )
    .max(30)
    .default([]),
  categories: z
    .array(
      z.object({
        code: z.string().regex(/^[a-z0-9_-]{1,50}$/),
        name: z.string().min(1).max(80),
      }),
    )
    .min(1)
    .max(30),
  systemPrompt: z
    .string()
    .max(4000)
    .default(
      "请依据当前应用知识库用中文回答。资料不足时明确说明，并建议用户提交工单。不要编造价格、地址或处理结果。",
    ),
});
export const projectSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/),
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(false),
  settings: settingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export type Project = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  version: number;
  api_key: string;
  api_secret: string;
  hook_secret: string;
  cw_hook_secret?: string;
  settings: Settings;
};
export type Conversation = {
  id: string;
  project_id: string;
  external_id: string;
  remote_id: string | null;
  ticket: boolean;
  category: string | null;
  subject: string | null;
  handoff_version: number;
  created_at: string;
  updated_at: string;
};
export type CWMessage = {
  id: number;
  content: string | null;
  message_type: number | string;
  private: boolean;
  content_attributes?: Record<string, any>;
  created_at: number;
  sender?: { id: number; type?: string };
};
export const incoming = (m: CWMessage) =>
  m.message_type === 0 || m.message_type === "incoming";
export const outgoing = (m: CWMessage) =>
  m.message_type === 1 || m.message_type === "outgoing";
export const publicMessage = (m: CWMessage) =>
  m.private === false && (incoming(m) || outgoing(m));
export function cleanMessage(m: CWMessage) {
  return {
    id: m.id,
    content: m.content || "",
    role: incoming(m)
      ? "user"
      : m.content_attributes?.support_ai
        ? "assistant"
        : "agent",
    createdAt: m.created_at,
    references: Array.isArray(m.content_attributes?.support_references)
      ? m.content_attributes!.support_references
      : [],
    suggestTicket: Boolean(m.content_attributes?.support_fallback),
  };
}
