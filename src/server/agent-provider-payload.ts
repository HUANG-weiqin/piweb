import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isCodexResponsesModel } from "./provider-context-pressure.js";

export interface ProviderPayloadModel {
  provider?: unknown;
  api?: unknown;
  id?: unknown;
}

export interface AgentProviderPayloadCheck {
  model: ProviderPayloadModel;
  serializedPayloadBytes: number | undefined;
}

export type AgentProviderPayloadHandler = (
  input: AgentProviderPayloadCheck,
) =>
  | Promise<{ block?: boolean; reason?: string } | undefined>
  | { block?: boolean; reason?: string }
  | undefined;

export type AgentProviderPayloadHook = (
  payload: unknown,
  model: ProviderPayloadModel,
) => unknown | undefined | Promise<unknown | undefined>;

interface AgentPayloadOwner {
  onPayload?: AgentProviderPayloadHook;
}

export interface AgentProviderPayloadController {
  dispose(): void;
}

/**
 * Composes the host check outside an existing payload transform. Codex payloads
 * are returned as stable JSON snapshots so the checked bytes are the bytes the
 * provider will serialize again immediately before transport.
 */
export function wrapAgentProviderPayloadHandler(
  originalOnPayload: AgentProviderPayloadHook | undefined,
  handler: AgentProviderPayloadHandler,
  receiver?: unknown,
): AgentProviderPayloadHook {
  return async (payload, model) => {
    const transformedPayload = await originalOnPayload?.call(
      receiver,
      payload,
      model,
    );
    const finalPayload = transformedPayload === undefined
      ? payload
      : transformedPayload;
    if (!isCodexResponsesModel(model)) return finalPayload;

    let serializedPayload: string | undefined;
    try {
      serializedPayload = JSON.stringify(finalPayload);
    } catch {
      serializedPayload = undefined;
    }
    const decision = await handler({
      model,
      serializedPayloadBytes: serializedPayload === undefined
        ? undefined
        : Buffer.byteLength(serializedPayload, "utf8"),
    });
    if (decision?.block) {
      throw new Error(
        decision.reason ?? "Provider request blocked by the workbench",
      );
    }
    // The provider serializes again after this hook. Return a plain snapshot so
    // getters, proxies, toJSON(), or concurrent mutation cannot change the
    // bytes between the host check and transport.
    return serializedPayload === undefined
      ? finalPayload
      : JSON.parse(serializedPayload) as unknown;
  };
}

/**
 * Runs the host payload check after extension payload transforms and immediately
 * before Pi serializes the value for a normal Agent provider request.
 */
export function installAgentProviderPayloadHandler(
  session: AgentSession,
  handler: AgentProviderPayloadHandler,
): AgentProviderPayloadController {
  const agent = session.agent as unknown as AgentPayloadOwner;
  const originalOnPayload = agent.onPayload;
  const hadOwnHandler = Object.hasOwn(agent, "onPayload");
  const onPayload = wrapAgentProviderPayloadHandler(
    originalOnPayload,
    handler,
    agent,
  );

  agent.onPayload = onPayload;
  let installed = true;
  return {
    dispose(): void {
      if (!installed) return;
      installed = false;
      if (agent.onPayload !== onPayload) return;
      if (hadOwnHandler) agent.onPayload = originalOnPayload;
      else delete agent.onPayload;
    },
  };
}
