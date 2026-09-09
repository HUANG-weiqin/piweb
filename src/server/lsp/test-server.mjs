import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const scenario = process.argv[2] ?? "normal";
let input = Buffer.alloc(0);
let nextServerRequestId = 10_000;
let rootUri = "";
const pendingServerRequests = new Map();
const state = { cancellations: [], registrations: [] };

if (scenario === "bad-header") {
  process.stdout.write("Content-Length nope\r\n\r\n");
} else if (scenario === "oversize") {
  process.stdout.write("Content-Length: 1048576\r\n\r\n");
} else if (scenario === "exit-before-init") {
  setTimeout(() => process.exit(23), 5);
} else if (scenario === "child-tree") {
  state.child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], {
    stdio: "ignore",
    windowsHide: true,
  }).pid;
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
    if (!match) throw new Error("fixture received a malformed LSP frame");
    const length = Number(match[1]);
    const frameEnd = headerEnd + 4 + length;
    if (input.length < frameEnd) return;
    const body = input.subarray(headerEnd + 4, frameEnd).toString("utf8");
    input = input.subarray(frameEnd);
    handle(JSON.parse(body));
  }
});

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

function send(message) {
  process.stdout.write(frame(message));
}

function sendFragmentedInitialize(message) {
  const first = frame(message);
  const second = frame({
    jsonrpc: "2.0",
    method: "window/logMessage",
    params: { type: 3, message: "second frame" },
  });
  const delimiter = first.indexOf("\r\n\r\n", 0, "ascii");
  process.stdout.write(first.subarray(0, delimiter + 3));
  process.stdout.write(first.subarray(delimiter + 3, delimiter + 4));
  process.stdout.write(Buffer.concat([first.subarray(delimiter + 4), second]));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendServerRequest(method, params) {
  const id = String(nextServerRequestId++);
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
  });
}

function capabilities() {
  if (scenario === "none" || scenario === "dynamic-query" || scenario === "registration-cap") return {};
  if (scenario === "utf8") {
    return { positionEncoding: "utf-8", workspaceSymbolProvider: true };
  }
  return {
    documentSymbolProvider: true,
    workspaceSymbolProvider: { resolveProvider: true },
    definitionProvider: true,
    referencesProvider: true,
  };
}

function respondInitialize(id) {
  const result = { capabilities: capabilities() };
  if (scenario === "fragmented") {
    sendFragmentedInitialize({ jsonrpc: "2.0", id, result });
  } else {
    respond(id, result);
  }
  if (scenario === "exit-after-init") setTimeout(() => process.exit(17), 10);
}

function startReverseInitialize(id) {
  const configuration = sendServerRequest("workspace/configuration", {
    items: [
      { scopeUri: rootUri, section: "probe.enabled" },
      { scopeUri: "file:///outside-root", section: "probe.enabled" },
      { section: "plain" },
    ],
  });
  const folders = sendServerRequest("workspace/workspaceFolders", {});
  const progress = sendServerRequest("window/workDoneProgress/create", { token: "reverse-progress" });
  void Promise.all([configuration, folders, progress]).then(([config, workspaceFolders, created]) => {
    state.reverse = {
      config: config.result,
      folders: workspaceFolders.result,
      progressCreated: created.result ?? null,
    };
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "reverse-progress", value: { kind: "begin", title: "index" } },
    });
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "reverse-progress", value: { kind: "end" } },
    });
    void sendServerRequest("window/workDoneProgress/create", { token: "reverse-progress" }).then((reused) => {
      state.reverse.progressReused = reused.result ?? null;
      respondInitialize(id);
    });
  });
}

function startPostInitializeRequests() {
  if (scenario === "register-watch") {
    void Promise.all([
      sendServerRequest("client/registerCapability", {
        registrations: [{
          id: "watch",
          method: "workspace/didChangeWatchedFiles",
          registerOptions: {
            watchers: [
              { globPattern: "**/*.dynamic" },
              { globPattern: { baseUri: rootUri, pattern: "config/*.json" } },
              { globPattern: "**/*.created", kind: 1 },
              { globPattern: "**/*.mixed", kind: 5 },
            ],
          },
        }],
      }),
      sendServerRequest("client/registerCapability", {
        registrations: [{
          id: "invalid-watch-kind",
          method: "workspace/didChangeWatchedFiles",
          registerOptions: { watchers: [{ globPattern: "**/*.invalid", kind: 8 }] },
        }],
      }),
    ]).then((responses) => state.registrations.push(...responses));
  }
  if (scenario === "dynamic-query") {
    void sendServerRequest("client/registerCapability", {
      registrations: [
        {
          id: "doc-symbol",
          method: "textDocument/documentSymbol",
          registerOptions: { documentSelector: [{ language: "fixture", scheme: "file" }] },
        },
        {
          id: "workspace-symbol",
          method: "workspace/symbol",
          registerOptions: { resolveProvider: true },
        },
      ],
    }).then((response) => state.registrations.push(response));
  }
  if (scenario === "registration-cap") {
    void (async () => {
      const acceptedConfiguration = await sendServerRequest("workspace/configuration", {
        items: Array.from({ length: 75 }, (_, index) => (
          index === 0 ? { section: "probe.enabled" }
            : index === 1 ? { section: "plain" }
              : { section: `unknown.${index}` }
        )),
      });
      const configuration = await sendServerRequest("workspace/configuration", {
        items: Array.from({ length: 129 }, () => ({ section: "plain" })),
      });
      const overflow = await sendServerRequest("client/registerCapability", {
        registrations: Array.from({ length: 65 }, (_, index) => ({
          id: `overflow-${index}`,
          method: "workspace/symbol",
        })),
      });
      const unregistration = await sendServerRequest("client/unregisterCapability", {
        unregisterations: Array.from({ length: 65 }, () => ({
          id: "overflow-0",
          method: "workspace/symbol",
        })),
      });
      const legal = await sendServerRequest("client/registerCapability", {
        registrations: [{ id: "legal", method: "workspace/symbol" }],
      });
      state.capacity = { acceptedConfiguration, configuration, overflow, unregistration, legal };
    })();
  }
  if (scenario === "failclosed") {
    void Promise.all([
      sendServerRequest("workspace/applyEdit", { edit: { changes: {} } }),
      sendServerRequest("fixture/unknown", {}),
    ]).then(([applyEdit, unknown]) => {
      state.reverse = { applyEdit, unknown };
    });
  }
}

function handleClientRequest(message) {
  if (message.method === "initialize") {
    rootUri = message.params?.rootUri ?? "";
    state.initialize = message.params;
    if (scenario === "hang-init" || scenario === "exit-before-init") return;
    if (scenario === "reverse") {
      startReverseInitialize(message.id);
    } else {
      respondInitialize(message.id);
    }
    return;
  }

  if (message.method === "shutdown") {
    if (scenario === "shutdown-wire" && process.env.PIWEB_LSP_FIXTURE_RECORD) {
      writeFileSync(process.env.PIWEB_LSP_FIXTURE_RECORD, JSON.stringify({
        hasParams: Object.hasOwn(message, "params"),
        params: message.params,
      }));
    }
    if (scenario !== "child-tree") respond(message.id, null);
    return;
  }

  if (message.method === "workspace/symbol") {
    const query = message.params?.query;
    if (query === "slow") {
      setTimeout(() => respond(message.id, { query, cancellations: state.cancellations.length }), 90);
      return;
    }
    if (query === "notfound") {
      respondError(message.id, -32601, "no workspace symbol");
      return;
    }
    if (query === "content-modified") {
      respondError(message.id, -32801, "document changed");
      return;
    }
    if (query === "state" || query === "reverse-state") {
      respond(message.id, state);
      return;
    }
    if (query === "child-pid") {
      respond(message.id, { pid: state.child });
      return;
    }
    if (query === "unregister" && scenario === "dynamic-query") {
      void sendServerRequest("client/unregisterCapability", {
        unregisterations: [
          { id: "doc-symbol", method: "textDocument/documentSymbol" },
          { id: "workspace-symbol", method: "workspace/symbol" },
        ],
      }).then((response) => {
        state.registrations.push(response);
        respond(message.id, state);
      });
      return;
    }
    respond(message.id, { query });
    return;
  }

  respond(message.id, null);
}

function handleClientNotification(message) {
  if (message.method === "workspace/didChangeConfiguration") {
    state.configurationNotification = message.params;
    return;
  }
  if (message.method === "initialized") {
    startPostInitializeRequests();
    return;
  }
  if (message.method === "$/cancelRequest") {
    state.cancellations.push(message.params?.id);
    return;
  }
  if (message.method === "exit" && scenario !== "child-tree") {
    setTimeout(() => process.exit(0), 0);
  }
}

function handle(message) {
  if (Object.hasOwn(message, "method")) {
    if (Object.hasOwn(message, "id")) handleClientRequest(message);
    else handleClientNotification(message);
    return;
  }
  if (!Object.hasOwn(message, "id")) return;
  const resolve = pendingServerRequests.get(String(message.id));
  if (!resolve) return;
  pendingServerRequests.delete(String(message.id));
  resolve(message);
}
