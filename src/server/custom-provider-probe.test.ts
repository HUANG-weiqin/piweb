import { describe, expect, it } from "vitest";
import { probeOpenAiCompatibleModels } from "./custom-provider-probe.js";

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    handler(String(input), init)) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 悬挂到 abort 的假 fetch：只观察 signal，不触网。 */
function hangingFetch(): typeof fetch {
  return fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
      { once: true },
    );
  }));
}

const BASE_URL = "http://127.0.0.1:8123/v1";
const MODELS_URL = `${BASE_URL}/models`;

describe("probeOpenAiCompatibleModels", () => {
  it("reads the OpenAI data shape without credentials and ignores missing enrichment endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      if (url === MODELS_URL) {
        return jsonResponse({ data: [{ id: "m1", name: "Model One" }, { id: "m2" }] });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await probeOpenAiCompatibleModels(
      "http://127.0.0.1:8123/v1/",
      { fetchImpl },
    );

    expect(result).toEqual({
      models: [{ id: "m1", name: "Model One" }, { id: "m2" }],
      truncated: false,
    });
    // 富化四级串行且顺序固定：主列表 → LM Studio 原生 → llama.cpp → Ollama。
    expect(calls.map((call) => call.url)).toEqual([
      MODELS_URL,
      "http://127.0.0.1:8123/api/v1/models",
      "http://127.0.0.1:8123/props",
      "http://127.0.0.1:8123/api/ps",
    ]);
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    }
  });

  it("accepts an empty model list without any enrichment request", async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      urls.push(url);
      return jsonResponse({ data: [] });
    });

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).resolves.toEqual({ models: [], truncated: false });
    expect(urls).toEqual([MODELS_URL]);
  });

  it("parses the LM Studio native shape and filters non-llm entries", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === "http://127.0.0.1:9000/models") {
        return jsonResponse({
          models: [
            { key: "llm-a", display_name: "A", type: "llm" },
            { key: "embed-a", display_name: "E", type: "embeddings" },
            { id: "llm-b", name: "B" },
            { display_name: "no id" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await probeOpenAiCompatibleModels("http://127.0.0.1:9000", { fetchImpl });
    expect(result).toEqual({
      models: [{ id: "llm-a", name: "A" }, { id: "llm-b", name: "B" }],
      truncated: false,
    });
  });

  it("reads context windows and output limits from generic model item fields", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) {
        return jsonResponse({
          data: [
            { id: "max-model-len", max_model_len: 32768 },
            { id: "context-length", context_length: 8192, max_completion_tokens: 4096 },
            { id: "max-context-length", max_context_length: 4096, max_output_tokens: 2048 },
            {
              id: "precedence",
              max_model_len: 1000,
              context_length: 2000,
              max_context_length: 3000,
              max_output_tokens: 100,
              max_completion_tokens: 200,
            },
            {
              id: "invalid",
              max_model_len: 0,
              context_length: 1.5,
              max_context_length: 100_000_001,
            },
            { id: "string", max_model_len: "32768" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await probeOpenAiCompatibleModels(BASE_URL, { fetchImpl });
    expect(result).toEqual({
      models: [
        { id: "max-model-len", contextWindow: 32768, contextSource: "models[].max_model_len" },
        {
          id: "context-length",
          contextWindow: 8192,
          contextSource: "models[].context_length",
          maxTokens: 4096,
        },
        {
          id: "max-context-length",
          contextWindow: 4096,
          contextSource: "models[].max_context_length",
          maxTokens: 2048,
        },
        {
          id: "precedence",
          contextWindow: 1000,
          contextSource: "models[].max_model_len",
          maxTokens: 100,
        },
        { id: "invalid" },
        { id: "string" },
      ],
      truncated: false,
    });
  });

  it("enriches probed models from the native LM Studio endpoint", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) {
        return jsonResponse({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }] });
      }
      if (url === "http://127.0.0.1:8123/api/v1/models") {
        return jsonResponse({
          models: [
            {
              key: "m1",
              display_name: "Native One",
              max_context_length: 4096,
              loaded_instances: [{ config: { context_length: 8192 } }],
              capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" }, vision: true },
            },
            {
              key: "m2",
              display_name: "Native Two",
              max_context_length: 2048,
              capabilities: {},
            },
            {
              key: "m3",
              display_name: "Native Three",
              max_context_length: 0,
            },
            {
              key: "m4",
              type: "embedding",
              display_name: "Embedding Four",
              max_context_length: 2048,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await probeOpenAiCompatibleModels(BASE_URL, { fetchImpl });
    // 未加载的模型不报`max_context_length`：那是架构上限，不等于实际分配；
    // embedding 条目不能作为聊天模型提供，整条不再出现在探测结果里。
    expect(result.models).toEqual([
      {
        id: "m1",
        name: "Native One",
        contextWindow: 8192,
        contextSource: "/api/v1/models",
        reasoning: true,
        input: ["text", "image"],
      },
      { id: "m2", name: "Native Two", input: ["text"] },
      { id: "m3", name: "Native Three", input: ["text"] },
    ]);
  });

  it("lets the LM Studio endpoint override the item field and later levels only fill gaps", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) {
        return jsonResponse({ data: [{ id: "m1", max_model_len: 4096 }] });
      }
      if (url === "http://127.0.0.1:8123/api/v1/models") {
        return jsonResponse({
          models: [{
            key: "m1",
            max_context_length: 8192,
            loaded_instances: [{ config: { context_length: 16384 } }],
          }],
        });
      }
      if (url === "http://127.0.0.1:8123/props") return jsonResponse({ n_ctx: 100 });
      if (url === "http://127.0.0.1:8123/api/ps") {
        return jsonResponse({ models: [{ name: "m1", context_length: 50 }] });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).resolves.toEqual({
      models: [{
        id: "m1",
        contextWindow: 16384,
        contextSource: "/api/v1/models",
        input: ["text"],
      }],
      truncated: false,
    });
  });

  it("fills missing context windows from llama.cpp /props and keeps explicit values", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) {
        return jsonResponse({
          data: [{ id: "no-context" }, { id: "explicit", max_model_len: 1000 }],
        });
      }
      if (url === "http://127.0.0.1:8123/props") {
        return jsonResponse({ default_generation_settings: { n_ctx: 4096 }, n_ctx: 2048 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).resolves.toEqual({
      models: [
        { id: "no-context", contextWindow: 4096, contextSource: "/props" },
        { id: "explicit", contextWindow: 1000, contextSource: "models[].max_model_len" },
      ],
      truncated: false,
    });
  });

  it("falls back to the top-level n_ctx and abandons unknown /props payloads", async () => {
    const probeWith = (payload: unknown) => probeOpenAiCompatibleModels(BASE_URL, {
      fetchImpl: fakeFetch((url) => {
        if (url === MODELS_URL) return jsonResponse({ data: [{ id: "m" }] });
        if (url === "http://127.0.0.1:8123/props") return jsonResponse(payload);
        return new Response("not found", { status: 404 });
      }),
    });

    await expect(probeWith({ n_ctx: 2048 })).resolves.toEqual({
      models: [{ id: "m", contextWindow: 2048, contextSource: "/props" }],
      truncated: false,
    });
    await expect(probeWith({ unrelated: true })).resolves.toEqual({
      models: [{ id: "m" }],
      truncated: false,
    });
    await expect(probeWith([1, 2, 3])).resolves.toEqual({
      models: [{ id: "m" }],
      truncated: false,
    });
    await expect(probeWith({ n_ctx: 0 })).resolves.toEqual({
      models: [{ id: "m" }],
      truncated: false,
    });
  });

  it("fills missing context windows from loaded Ollama models with :latest normalization", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) {
        return jsonResponse({
          data: [
            { id: "llama3" },
            { id: "qwen2.5:latest" },
            { id: "explicit", max_model_len: 1000 },
            { id: "unloaded" },
          ],
        });
      }
      if (url === "http://127.0.0.1:8123/api/ps") {
        return jsonResponse({
          models: [
            { name: "llama3:latest", context_length: 8192 },
            { model: "qwen2.5", context_length: 4096 },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).resolves.toEqual({
      models: [
        { id: "llama3", contextWindow: 8192, contextSource: "/api/ps" },
        { id: "qwen2.5:latest", contextWindow: 4096, contextSource: "/api/ps" },
        { id: "explicit", contextWindow: 1000, contextSource: "models[].max_model_len" },
        { id: "unloaded" },
      ],
      truncated: false,
    });
  });

  it("abandons /api/ps entirely on any shape violation", async () => {
    const probeWith = (payload: unknown) => probeOpenAiCompatibleModels(BASE_URL, {
      fetchImpl: fakeFetch((url) => {
        if (url === MODELS_URL) return jsonResponse({ data: [{ id: "m" }] });
        if (url === "http://127.0.0.1:8123/api/ps") return jsonResponse(payload);
        return new Response("not found", { status: 404 });
      }),
    });
    const expected = { models: [{ id: "m" }], truncated: false };

    await expect(probeWith({ models: "nope" })).resolves.toEqual(expected);
    await expect(probeWith({
      models: [{ name: "m", context_length: 8192 }, { name: "broken" }],
    })).resolves.toEqual(expected);
    await expect(probeWith({ models: [{ name: "m", context_length: 0 }] })).resolves.toEqual(expected);
    await expect(probeWith({ models: [{ context_length: 8192 }] })).resolves.toEqual(expected);
  });

  it("continues to later levels after a malformed earlier level", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) return jsonResponse({ data: [{ id: "m" }] });
      if (url === "http://127.0.0.1:8123/props") return jsonResponse({ unexpected: true });
      if (url === "http://127.0.0.1:8123/api/ps") {
        return jsonResponse({ models: [{ name: "m", context_length: 8192 }] });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).resolves.toEqual({
      models: [{ id: "m", contextWindow: 8192, contextSource: "/api/ps" }],
      truncated: false,
    });
  });

  it("shares one deadline across the ladder without failing the probe", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === MODELS_URL) {
        return jsonResponse({ data: [{ id: "m", max_model_len: 4096 }] });
      }
      if (url === "http://127.0.0.1:8123/props") {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("props aborted")), { once: true });
        });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl, timeoutMs: 30 }),
    ).resolves.toEqual({
      models: [{ id: "m", contextWindow: 4096, contextSource: "models[].max_model_len" }],
      truncated: false,
    });
  });

  it("keeps the probed list when all enrichment levels fail", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) {
        return jsonResponse({ data: [{ id: "m1" }] });
      }
      throw new Error("enrichment endpoint unavailable");
    });

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).resolves.toEqual({ models: [{ id: "m1" }], truncated: false });
  });

  it("deduplicates ids and reports truncation past 256 models", async () => {
    const data = [
      ...Array.from({ length: 300 }, (_, index) => ({ id: `m${index}` })),
      { id: "m0" },
      { id: "m1" },
    ];
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) return jsonResponse({ data });
      return new Response("not found", { status: 404 });
    });

    const result = await probeOpenAiCompatibleModels(BASE_URL, { fetchImpl });
    expect(result.models).toHaveLength(256);
    expect(new Set(result.models.map((model) => model.id)).size).toBe(256);
    expect(result.models[0].id).toBe("m0");
    expect(result.models[255].id).toBe("m255");
    expect(result.truncated).toBe(true);
  });

  it("drops entries whose id cannot cross the wire schema", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === MODELS_URL) {
        return jsonResponse({
          data: [
            { id: "ok" },
            { id: "x".repeat(257) },
            { id: "also-ok" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    // 超长 id 不得进入投影：否则 probe 事件会违反线协议并触发连接级 4002 关闭。
    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).resolves.toEqual({
      models: [{ id: "ok" }, { id: "also-ok" }],
      truncated: false,
    });
  });

  it("aborts response streaming once the body exceeds 1 MiB", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulls >= 64) controller.close();
      },
    });
    const fetchImpl = fakeFetch(() => new Response(stream, { status: 200 }));

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).rejects.toThrow(/exceeds the 1048576 byte limit/);
    expect(pulls).toBeLessThan(32);
  });

  it("times out when the deadline expires", async () => {
    await expect(
      probeOpenAiCompatibleModels(BASE_URL, {
        fetchImpl: hangingFetch(),
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out after 30 ms/);
  });

  it("propagates an external abort without claiming a timeout", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    await expect(
      probeOpenAiCompatibleModels(BASE_URL, {
        fetchImpl: hangingFetch(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled by user/);
  });

  it("reports network failures with the probed URL", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(
      probeOpenAiCompatibleModels(BASE_URL, { fetchImpl }),
    ).rejects.toThrow(
      /Failed to fetch http:\/\/127\.0\.0\.1:8123\/v1\/models: connect ECONNREFUSED/,
    );
  });

  it("rejects invalid or non-http base URLs before any request", async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      urls.push(url);
      return jsonResponse({ data: [] });
    });

    await expect(
      probeOpenAiCompatibleModels("ftp://models.example.com/v1", { fetchImpl }),
    ).rejects.toThrow(/must be an absolute http\(s\) URL/);
    await expect(probeOpenAiCompatibleModels("not a url", { fetchImpl }))
      .rejects.toThrow(/Invalid custom provider base URL/);
    await expect(probeOpenAiCompatibleModels("http://", { fetchImpl }))
      .rejects.toThrow(/Invalid custom provider base URL/);
    expect(urls).toEqual([]);
  });

  it("rejects HTTP errors, non-JSON bodies, and unknown shapes", async () => {
    await expect(
      probeOpenAiCompatibleModels(BASE_URL, {
        fetchImpl: fakeFetch(() => new Response("nope", { status: 500 })),
      }),
    ).rejects.toThrow(/failed with HTTP 500/);

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, {
        fetchImpl: fakeFetch(() => new Response("<html>", { status: 200 })),
      }),
    ).rejects.toThrow(/is not valid JSON/);

    await expect(
      probeOpenAiCompatibleModels(BASE_URL, {
        fetchImpl: fakeFetch(() => jsonResponse({ objects: [] })),
      }),
    ).rejects.toThrow(/neither a "data" nor a "models" array/);
  });
});
