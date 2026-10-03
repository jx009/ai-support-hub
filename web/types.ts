export type Project = {
  code: string;
  name: string;
  welcome: string;
  color: string;
  questions: { id: string; question: string }[];
  categories: { code: string; name: string }[];
  configVersion: number;
};
export type Bootstrap = {
  project: Project;
  session: { token: string; expiresIn: number };
  embedOrigin: string;
  publicUrl: string;
};
export type Message = {
  id: number;
  content: string;
  role: "user" | "assistant" | "agent";
  createdAt: number;
  references: { title?: string; url?: string }[];
  suggestTicket: boolean;
};
export type Conversation = {
  id: string;
  ticket: boolean;
  subject: string | null;
  category: string | null;
  status: string;
  createdAt: string;
};
