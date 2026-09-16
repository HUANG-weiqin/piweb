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

describe("probeOpenAiCompatibleModels", () => {
  it("reads the OpenAI data shape without sending credentials and ignores a missing native endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      if (url === "http://127.0.0.1:8123/v1/models") {
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
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8123/v1/models",
      "http://127.0.0.1:8123/api/v1/models",
    ]);
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    }
  });

  it("accepts an empty model list without calling the native endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      urls.push(url);
      return jsonResponse({ data: [] });
    });

    await expect(
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", { fetchImpl }),
    ).resolves.toEqual({ models: [], truncated: false });
    expect(urls).toEqual(["http://127.0.0.1:8123/v1/models"]);
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

  it("enriches probed models from the native LM Studio endpoint", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === "http://127.0.0.1:8123/v1/models") {
        return jsonResponse({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
      }
      if (url === "http://127.0.0.1:8123/api/v1/models") {
        return jsonResponse({
          models: [
            {
              key: "m1",
              display_name: "Native One",
              max_context_length: 4096,
              loaded_instances: [{ config: { context_length: 8192 } }],
              capabilities: { reasoning: true, vision: true },
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
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", { fetchImpl });
    expect(result.models).toEqual([
      {
        id: "m1",
        name: "Native One",
        contextWindow: 8192,
        reasoning: true,
        input: ["text", "image"],
      },
      { id: "m2", name: "Native Two", contextWindow: 2048, input: ["text"] },
      { id: "m3", name: "Native Three", input: ["text"] },
    ]);
  });

  it("keeps the probed list when enrichment fails", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === "http://127.0.0.1:8123/v1/models") {
        return jsonResponse({ data: [{ id: "m1" }] });
      }
      throw new Error("native endpoint unavailable");
    });

    await expect(
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", { fetchImpl }),
    ).resolves.toEqual({ models: [{ id: "m1" }], truncated: false });
  });

  it("deduplicates ids and reports truncation past 256 models", async () => {
    const data = [
      ...Array.from({ length: 300 }, (_, index) => ({ id: `m${index}` })),
      { id: "m0" },
      { id: "m1" },
    ];
    const fetchImpl = fakeFetch((url) => {
      if (url === "http://127.0.0.1:8123/v1/models") return jsonResponse({ data });
      return new Response("not found", { status: 404 });
    });

    const result = await probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", { fetchImpl });
    expect(result.models).toHaveLength(256);
    expect(new Set(result.models.map((model) => model.id)).size).toBe(256);
    expect(result.models[0].id).toBe("m0");
    expect(result.models[255].id).toBe("m255");
    expect(result.truncated).toBe(true);
  });

  it("drops entries whose id cannot cross the wire schema", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === "http://127.0.0.1:8123/v1/models") {
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
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", { fetchImpl }),
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
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", { fetchImpl }),
    ).rejects.toThrow(/exceeds the 1048576 byte limit/);
    expect(pulls).toBeLessThan(32);
  });

  it("times out when the deadline expires", async () => {
    await expect(
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", {
        fetchImpl: hangingFetch(),
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out after 30 ms/);
  });

  it("propagates an external abort without claiming a timeout", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    await expect(
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", {
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
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", { fetchImpl }),
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
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", {
        fetchImpl: fakeFetch(() => new Response("nope", { status: 500 })),
      }),
    ).rejects.toThrow(/failed with HTTP 500/);

    await expect(
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", {
        fetchImpl: fakeFetch(() => new Response("<html>", { status: 200 })),
      }),
    ).rejects.toThrow(/is not valid JSON/);

    await expect(
      probeOpenAiCompatibleModels("http://127.0.0.1:8123/v1", {
        fetchImpl: fakeFetch(() => jsonResponse({ objects: [] })),
      }),
    ).rejects.toThrow(/neither a "data" nor a "models" array/);
  });
});
