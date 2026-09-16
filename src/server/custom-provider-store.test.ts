import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomProviderSaveInput } from "../shared/protocol.js";
import { CustomProviderStore } from "./custom-provider-store.js";

const tempDirectories: string[] = [];

async function makeModelsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "piweb-custom-provider-store-"));
  tempDirectories.push(directory);
  return join(directory, "models.json");
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function makeStore(modelsPath: string, builtinProviderIds: readonly string[] = []): CustomProviderStore {
  return new CustomProviderStore({
    modelsPath,
    builtinProviderIds: new Set(builtinProviderIds),
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CustomProviderStore", () => {
  it("returns an absent snapshot in memory mode and refuses file writes", async () => {
    const store = CustomProviderStore.memory();
    await expect(store.read()).resolves.toEqual({
      revision: "absent",
      providers: [],
      truncated: false,
    });
    const input: CustomProviderSaveInput = {
      id: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "local" },
      models: [{ id: "m" }],
    };
    await expect(store.save(input, "absent")).rejects.toThrow(/cannot be saved/);
    await expect(store.delete("local", "absent")).rejects.toThrow(/cannot be saved/);
  });

  it("reads a missing models.json as absent", async () => {
    const store = makeStore(await makeModelsPath());
    await expect(store.read()).resolves.toEqual({
      revision: "absent",
      providers: [],
      truncated: false,
    });
  });

  it("fails closed on invalid JSON while keeping the byte revision", async () => {
    const modelsPath = await makeModelsPath();
    const content = '{"providers": {"a": }}\n';
    await writeFile(modelsPath, content, "utf8");
    const view = await makeStore(modelsPath).read();
    expect(view.providers).toEqual([]);
    expect(view.error).toMatch(/^Failed to parse models\.json/);
    expect(view.revision).toBe(sha256(content));
    expect(view.truncated).toBe(false);
  });

  it("fails closed when the top level or providers is not an object", async () => {
    const topLevelPath = await makeModelsPath();
    await writeFile(topLevelPath, "[]\n", "utf8");
    await expect(makeStore(topLevelPath).read()).resolves.toMatchObject({
      providers: [],
      error: expect.stringMatching(/expected a top-level JSON object/),
    });

    const providersPath = await makeModelsPath();
    await writeFile(providersPath, '{"providers": []}\n', "utf8");
    await expect(makeStore(providersPath).read()).resolves.toMatchObject({
      providers: [],
      error: expect.stringMatching(/"providers" must be an object/),
    });
  });

  it("rejects a models.json larger than 4 MiB without reading providers", async () => {
    const modelsPath = await makeModelsPath();
    await writeFile(modelsPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const view = await makeStore(modelsPath).read();
    expect(view.providers).toEqual([]);
    expect(view.error).toMatch(/exceeds 4194304 bytes/);
    expect(view.revision).toBe("error");
  });

  it("projects provider and model fields without leaking apiKey values", async () => {
    const modelsPath = await makeModelsPath();
    const content = `{
  // alpha provider
  "providers": {
    "local-alpha": {
      "name": "Alpha",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "api": "openai-completions",
      "apiKey": "$ALPHA_KEY",
      "headers": { "X-Token": "$ALPHA_TOKEN" },
      "models": [
        {
          "id": "alpha-1",
          "name": "Alpha One",
          "contextWindow": 8192,
          "maxTokens": 1024,
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 1 },
          "samplingParams": { "temperature": 0.5 }
        },
        { "id": "alpha-2" }
      ]
    },
    "beta": {
      "baseUrl": "https://beta.example.com/v1",
      "api": "openai-responses",
      "apiKey": "sk-literal-secret",
      "compat": { "supportsStrictMode": true },
      "models": [{ "id": "beta-1" }]
    }
  }
}
`;
    await writeFile(modelsPath, content, "utf8");
    const view = await makeStore(modelsPath).read();

    expect(view.error).toBeUndefined();
    expect(view.truncated).toBe(false);
    expect(view.revision).toBe(sha256(content));
    expect(view.providers).toEqual([
      {
        id: "local-alpha",
        name: "Alpha",
        baseUrl: "http://127.0.0.1:1234/v1",
        api: "openai-completions",
        storedAuth: "env",
        authEnvNames: ["ALPHA_KEY"],
        models: [
          {
            id: "alpha-1",
            name: "Alpha One",
            contextWindow: 8192,
            maxTokens: 1024,
            reasoning: true,
            input: ["text", "image"],
            extraFields: ["cost", "samplingParams"],
          },
          { id: "alpha-2", extraFields: [] },
        ],
        extraFields: ["headers"],
        editable: true,
        builtinOverride: false,
      },
      {
        id: "beta",
        baseUrl: "https://beta.example.com/v1",
        api: "openai-responses",
        storedAuth: "literal",
        authEnvNames: [],
        models: [{ id: "beta-1", extraFields: [] }],
        extraFields: ["compat"],
        editable: true,
        builtinOverride: false,
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("sk-literal-secret");
  });

  it("classifies stored auth shapes and never reports a secret value", async () => {
    const modelsPath = await makeModelsPath();
    const provider = (apiKey: string | undefined) => ({
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      ...(apiKey === undefined ? {} : { apiKey }),
      models: [{ id: "m" }],
    });
    await writeFile(modelsPath, `${JSON.stringify({
      providers: {
        "no-key": provider(undefined),
        "env-brace": provider("prefix-${BRACE_KEY}-suffix"),
        "env-many": provider("$SIMPLE_VAR-${BRACE_KEY}-$SIMPLE_VAR"),
        "command-secret": provider("!vault read secret"),
        "escaped": provider("pa$$word-$!"),
        "invalid-name": provider("cost: $5"),
      },
    }, null, 2)}\n`, "utf8");

    const view = await makeStore(modelsPath).read();
    const auth = Object.fromEntries(
      view.providers.map((entry) => [entry.id, {
        storedAuth: entry.storedAuth,
        authEnvNames: entry.authEnvNames,
      }]),
    );
    expect(auth).toEqual({
      "no-key": { storedAuth: "none", authEnvNames: [] },
      "env-brace": { storedAuth: "env", authEnvNames: ["BRACE_KEY"] },
      "env-many": { storedAuth: "env", authEnvNames: ["SIMPLE_VAR", "BRACE_KEY"] },
      "command-secret": { storedAuth: "command", authEnvNames: [] },
      "escaped": { storedAuth: "literal", authEnvNames: [] },
      "invalid-name": { storedAuth: "literal", authEnvNames: [] },
    });
    expect(JSON.stringify(view)).not.toContain("vault read secret");
  });

  it("marks only form-shaped providers as editable and flags builtin overrides", async () => {
    const modelsPath = await makeModelsPath();
    await writeFile(modelsPath, `${JSON.stringify({
      providers: {
        "editable-one": {
          baseUrl: "https://models.example.com/v1",
          api: "openai-completions",
          models: [{ id: "m" }],
        },
        "builtin-one": {
          baseUrl: "https://models.example.com/v1",
          api: "openai-completions",
          models: [{ id: "m" }],
        },
        "bad id!": {
          baseUrl: "https://models.example.com/v1",
          api: "openai-completions",
          models: [{ id: "m" }],
        },
        "relative-url": { baseUrl: "/v1", api: "openai-completions", models: [{ id: "m" }] },
        "unknown-api": {
          baseUrl: "https://models.example.com/v1",
          api: "made-up",
          models: [{ id: "m" }],
        },
        "no-models": {
          baseUrl: "https://models.example.com/v1",
          api: "openai-completions",
          models: [],
        },
        "model-without-id": {
          baseUrl: "https://models.example.com/v1",
          api: "openai-completions",
          models: [{}],
        },
        "oauth-provider": {
          baseUrl: "https://models.example.com/v1",
          api: "openai-completions",
          oauth: "radius",
          models: [{ id: "m" }],
        },
      },
    }, null, 2)}\n`, "utf8");

    const view = await makeStore(modelsPath, ["builtin-one"]).read();
    const flags = Object.fromEntries(
      view.providers.map((entry) => [entry.id, {
        editable: entry.editable,
        builtinOverride: entry.builtinOverride,
      }]),
    );
    expect(flags).toEqual({
      "editable-one": { editable: true, builtinOverride: false },
      "builtin-one": { editable: false, builtinOverride: true },
      "bad id!": { editable: false, builtinOverride: false },
      "relative-url": { editable: false, builtinOverride: false },
      "unknown-api": { editable: false, builtinOverride: false },
      "no-models": { editable: false, builtinOverride: false },
      "model-without-id": { editable: false, builtinOverride: false },
      "oauth-provider": { editable: false, builtinOverride: false },
    });
  });

  it("truncates the snapshot to 32 providers and 64 models per provider", async () => {
    const modelsPath = await makeModelsPath();
    const providers: Record<string, unknown> = {};
    for (let index = 0; index < 33; index++) {
      providers[`p${String(index).padStart(2, "0")}`] = {
        baseUrl: "http://127.0.0.1:1234/v1",
        api: "openai-completions",
        models: [],
      };
    }
    (providers.p00 as { models: unknown[] }).models = Array.from(
      { length: 65 },
      (_, index) => ({ id: `m${index}` }),
    );
    await writeFile(modelsPath, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");

    const view = await makeStore(modelsPath).read();
    expect(view.providers).toHaveLength(32);
    expect(view.providers[0].models).toHaveLength(64);
    expect(view.providers[0].models[63]).toEqual({ id: "m63", extraFields: [] });
    expect(view.truncated).toBe(true);
  });

  it("creates models.json for a new provider with local auth", async () => {
    const modelsPath = await makeModelsPath();
    const store = makeStore(modelsPath);
    const view = await store.save({
      id: "local-1",
      name: "Local",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "local" },
      models: [{ id: "m1", name: "M1" }],
    }, "absent");

    const expected = `{
  "providers": {
    "local-1": {
      "name": "Local",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "api": "openai-completions",
      "apiKey": "piweb-local",
      "models": [
        {
          "id": "m1",
          "name": "M1"
        }
      ]
    }
  }
}
`;
    await expect(readFile(modelsPath, "utf8")).resolves.toBe(expected);
    expect(view.revision).toBe(sha256(expected));
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]).toMatchObject({
      id: "local-1",
      storedAuth: "literal",
      editable: true,
      builtinOverride: false,
    });
  });

  it("edits one provider while preserving comments, unknown fields, and siblings", async () => {
    const modelsPath = await makeModelsPath();
    const content = `{
  // keep alpha
  "providers": {
    "alpha": {
      "name": "Alpha",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "api": "openai-completions",
      "apiKey": "$ALPHA_KEY",
      "compat": { "supportsStrictMode": true },
      "models": [
        { "id": "alpha-1", "name": "Alpha One", "cost": { "input": 1 } },
        { "id": "alpha-3" }
      ]
    },
    "beta": {
      "baseUrl": "https://beta.example.com/v1",
      "api": "openai-responses",
      "models": [{ "id": "beta-1" }]
    }
  },
  "unrelated": true
}
`;
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await store.save({
      id: "alpha",
      name: "Alpha Two",
      baseUrl: "http://127.0.0.1:9999/v1",
      api: "openai-completions",
      auth: { kind: "keep" },
      models: [
        { id: "alpha-1", contextWindow: 16384 },
        { id: "alpha-2", name: "New" },
      ],
    }, sha256(content));

    const expected = `{
  // keep alpha
  "providers": {
    "alpha": {
      "name": "Alpha Two",
      "baseUrl": "http://127.0.0.1:9999/v1",
      "api": "openai-completions",
      "apiKey": "$ALPHA_KEY",
      "compat": {
        "supportsStrictMode": true
      },
      "models": [
        {
          "id": "alpha-1",
          "cost": {
            "input": 1
          },
          "contextWindow": 16384
        },
        {
          "id": "alpha-2",
          "name": "New"
        }
      ]
    },
    "beta": {
      "baseUrl": "https://beta.example.com/v1",
      "api": "openai-responses",
      "models": [{ "id": "beta-1" }]
    }
  },
  "unrelated": true
}
`;
    await expect(readFile(modelsPath, "utf8")).resolves.toBe(expected);
    const view = await store.read();
    expect(view.revision).toBe(sha256(expected));
    expect(view.providers[0]).toMatchObject({
      id: "alpha",
      name: "Alpha Two",
      storedAuth: "env",
      authEnvNames: ["ALPHA_KEY"],
    });
    expect(view.providers[0].models.map((model) => model.id)).toEqual(["alpha-1", "alpha-2"]);
    expect(view.providers[0].models[0].extraFields).toEqual(["cost"]);
    expect(view.providers[1].id).toBe("beta");
  });

  it("appends a new provider after existing members and comments", async () => {
    const modelsPath = await makeModelsPath();
    const content = `{
  "providers": {
    // alpha stays
    "alpha": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "apiKey": "piweb-local", "models": [{ "id": "m1" }] }
  }
}
`;
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await store.save({
      id: "gamma",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-responses",
      auth: { kind: "env", envName: "GAMMA_KEY" },
      models: [{ id: "g1" }],
    }, sha256(content));

    await expect(readFile(modelsPath, "utf8")).resolves.toBe(`{
  "providers": {
    // alpha stays
    "alpha": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "apiKey": "piweb-local", "models": [{ "id": "m1" }] },
    "gamma": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "api": "openai-responses",
      "apiKey": "$GAMMA_KEY",
      "models": [
        {
          "id": "g1"
        }
      ]
    }
  }
}
`);
  });

  it("inserts a provider into an empty providers object", async () => {
    const modelsPath = await makeModelsPath();
    const content = '{\n  "providers": {}\n}\n';
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await store.save({
      id: "solo",
      baseUrl: "https://models.example.com/v1",
      api: "anthropic-messages",
      auth: { kind: "credential" },
      models: [{ id: "solo-1", reasoning: false }],
    }, sha256(content));

    await expect(readFile(modelsPath, "utf8")).resolves.toBe(`{
  "providers": {
    "solo": {
      "baseUrl": "https://models.example.com/v1",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "solo-1",
          "reasoning": false
        }
      ]
    }
  }
}
`);
  });

  it("applies keep, credential, env, and local auth to an existing provider", async () => {
    const modelsPath = await makeModelsPath();
    const baseInput: CustomProviderSaveInput = {
      id: "alpha",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "keep" },
      models: [{ id: "m" }],
    };
    await writeFile(modelsPath, `${JSON.stringify({
      providers: {
        alpha: {
          baseUrl: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          apiKey: "!vault read alpha",
          models: [{ id: "m" }],
        },
      },
    }, null, 2)}\n`, "utf8");
    const store = makeStore(modelsPath);

    let view = await store.read();
    expect(view.providers[0].storedAuth).toBe("command");
    await store.save(baseInput, view.revision);
    await expect(readFile(modelsPath, "utf8")).resolves.toContain('"!vault read alpha"');

    view = await store.read();
    await store.save({ ...baseInput, auth: { kind: "credential" } }, view.revision);
    await expect(readFile(modelsPath, "utf8")).resolves.not.toContain("apiKey");
    view = await store.read();
    expect(view.providers[0].storedAuth).toBe("none");

    await store.save({ ...baseInput, auth: { kind: "env", envName: "REMOTE_KEY" } }, view.revision);
    await expect(readFile(modelsPath, "utf8")).resolves.toContain('"$REMOTE_KEY"');

    view = await store.read();
    await store.save({ ...baseInput, auth: { kind: "local" } }, view.revision);
    await expect(readFile(modelsPath, "utf8")).resolves.toContain('"piweb-local"');
    view = await store.read();
    expect(view.providers[0].storedAuth).toBe("literal");
  });

  it("deletes a middle provider without reformatting its siblings", async () => {
    const modelsPath = await makeModelsPath();
    const content = `{
  "providers": {
    "alpha": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] },
    "beta": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] },
    "gamma": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] }
  }
}
`;
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await store.delete("beta", sha256(content));

    await expect(readFile(modelsPath, "utf8")).resolves.toBe(`{
  "providers": {
    "alpha": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] },
    "gamma": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] }
  }
}
`);
  });

  it("deletes the last provider together with its preceding comma", async () => {
    const modelsPath = await makeModelsPath();
    const content = `{
  "providers": {
    "alpha": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] },
    "gamma": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] }
  }
}
`;
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await store.delete("gamma", sha256(content));

    await expect(readFile(modelsPath, "utf8")).resolves.toBe(`{
  "providers": {
    "alpha": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] }
  }
}
`);
  });

  it("keeps an empty providers object after deleting the only provider", async () => {
    const modelsPath = await makeModelsPath();
    const content = `{
  "providers": {
    "alpha": { "baseUrl": "http://127.0.0.1:1234/v1", "api": "openai-completions", "models": [{ "id": "m" }] }
  }
}
`;
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    const view = await store.delete("alpha", sha256(content));

    await expect(readFile(modelsPath, "utf8")).resolves.toBe(
      '{\n  "providers": {\n  }\n}\n',
    );
    expect(view.providers).toEqual([]);
    expect(view.truncated).toBe(false);
  });

  it("rejects a stale revision and leaves the file unchanged", async () => {
    const modelsPath = await makeModelsPath();
    const content = '{\n  "providers": {}\n}\n';
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);
    const input: CustomProviderSaveInput = {
      id: "alpha",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "local" },
      models: [{ id: "m" }],
    };

    await expect(store.save(input, "absent")).rejects.toThrow(/models\.json 已被外部修改/);
    await expect(store.delete("alpha", sha256("other"))).rejects.toThrow(/models\.json 已被外部修改/);
    await expect(readFile(modelsPath, "utf8")).resolves.toBe(content);
  });

  it("rejects keep auth for a provider that is not present in the file", async () => {
    const modelsPath = await makeModelsPath();
    const content = '{\n  "providers": {}\n}\n';
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await expect(store.save({
      id: "missing",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "keep" },
      models: [{ id: "m" }],
    }, sha256(content))).rejects.toThrow(/Cannot keep the existing apiKey/);
    await expect(readFile(modelsPath, "utf8")).resolves.toBe(content);
  });

  it("rejects deleting a provider that is not present in the file", async () => {
    const modelsPath = await makeModelsPath();
    const content = '{\n  "providers": {}\n}\n';
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await expect(store.delete("missing", sha256(content))).rejects.toThrow(/is not present/);
    await expect(readFile(modelsPath, "utf8")).resolves.toBe(content);
  });

  it("serializes concurrent writes so only the accepted revision wins", async () => {
    const modelsPath = await makeModelsPath();
    const store = makeStore(modelsPath);
    const makeInput = (id: string): CustomProviderSaveInput => ({
      id,
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "local" },
      models: [{ id: "m" }],
    });

    const results = await Promise.allSettled([
      store.save(makeInput("first"), "absent"),
      store.save(makeInput("second"), "absent"),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    if (results[1].status === "rejected") {
      expect(String(results[1].reason)).toMatch(/models\.json 已被外部修改/);
    }
    const view = await store.read();
    expect(view.providers.map((entry) => entry.id)).toEqual(["first"]);
  });

  it("fails closed on a corrupt file without writing or leaving temporary files", async () => {
    const modelsPath = await makeModelsPath();
    const content = '{"providers": {"a": }}\n';
    await writeFile(modelsPath, content, "utf8");
    const store = makeStore(modelsPath);

    await expect(store.read()).resolves.toMatchObject({
      error: expect.stringMatching(/^Failed to parse models\.json/),
    });
    await expect(store.save({
      id: "alpha",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions",
      auth: { kind: "local" },
      models: [{ id: "m" }],
    }, sha256(content))).rejects.toThrow(/^Failed to parse models\.json/);
    await expect(store.delete("a", sha256(content))).rejects.toThrow(/^Failed to parse models\.json/);
    await expect(readFile(modelsPath, "utf8")).resolves.toBe(content);
    await expect(readdir(dirname(modelsPath))).resolves.toEqual(["models.json"]);
  });
});
