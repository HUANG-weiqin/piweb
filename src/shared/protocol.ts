import { z } from "zod";

export const MAX_MESSAGE_BYTES = 1_000_000;
const required = z.string().trim().min(1);

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialize"), cwd: required.max(4096) }),
  z.object({ type: z.literal("prompt"), text: required.max(200_000) }),
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("select_model"), provider: required, modelId: required }),
  z.object({ type: z.literal("set_thinking"), level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]) }),
  z.object({ type: z.literal("set_api_key"), provider: required, key: required.max(32_768) }),
  z.object({ type: z.literal("login_oauth"), provider: required }),
  z.object({ type: z.literal("logout"), provider: required }),
  z.object({ type: z.literal("auth_response"), requestId: required, value: z.string().optional(), selectedId: z.string().optional(), cancelled: z.boolean().optional() }),
  z.object({ type: z.literal("cancel_auth") }),
  z.object({ type: z.literal("refresh_models") }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type ThinkingLevel = Extract<ClientCommand, { type: "set_thinking" }>['level'];

export interface PublicModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  available: boolean;
}

export interface PublicProvider {
  id: string;
  name: string;
  configured: boolean;
  authSource?: string;
  authLabel?: string;
  oauth: boolean;
  models: PublicModel[];
}

export interface PublicState {
  cwd: string;
  busy: boolean;
  selectedModel?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  providers: PublicProvider[];
  registryError?: string;
}

export type AuthRequest =
  | { kind: "auth"; url: string; instructions?: string }
  | { kind: "device"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: "prompt" | "manual"; message: string; placeholder?: string; allowEmpty?: boolean }
  | { kind: "select"; message: string; options: Array<{ id: string; label: string }> };

export type ServerEvent =
  | { type: "hello"; startupCwd: string }
  | { type: "state"; state: PublicState }
  | { type: "session_event"; event: unknown }
  | { type: "auth_request"; requestId: string; request: AuthRequest }
  | { type: "auth_progress"; message: string }
  | { type: "auth_complete"; provider: string }
  | { type: "error"; message: string };

export function parseClientCommand(input: unknown): ClientCommand {
  let value = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAX_MESSAGE_BYTES) throw new Error("Message is too large");
    value = JSON.parse(input);
  }
  return clientCommandSchema.parse(value);
}
