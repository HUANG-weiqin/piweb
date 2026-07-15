# Minimal Pi Web UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local-only web UI that embeds Pi's SDK, reuses native authentication/model/settings storage, runs ephemeral coding-agent sessions, and supports all Pi-discovered API-key and OAuth providers.

**Architecture:** A React/Vite client connects to a long-lived Express/`ws` Node server. The server adapts a small validated WebSocket protocol to public Pi SDK APIs and owns one in-memory `AgentSession` per connection. Native Pi stores remain the sole source of truth for credentials, models, and default model settings.

**Tech Stack:** Node.js 22.19+, TypeScript, React, Vite, Express, ws, Zod, marked, DOMPurify, Vitest, Testing Library.

---

### Task 1: Bootstrap the TypeScript application

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `.gitignore`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/styles.css`
- Create: `src/server/index.ts`

**Steps:**
1. Add npm scripts for `dev`, `build`, `start`, `typecheck`, and `test`.
2. Add Pi SDK, Express, ws, Zod, React, Markdown, build, and test dependencies.
3. Add a minimal Vite client and Express health endpoint.
4. Run `npm install`.
5. Run `npm run typecheck` and `npm run build`; expect both to pass.
6. Commit as `chore: bootstrap pi web ui`.

### Task 2: Define and validate the WebSocket protocol

**Files:**
- Create: `src/shared/protocol.ts`
- Create: `src/shared/protocol.test.ts`

**Steps:**
1. Write failing tests for every supported client command and malformed/oversized payload rejection.
2. Run `npm test -- src/shared/protocol.test.ts`; expect failure because schemas do not exist.
3. Define discriminated Zod schemas and shared sanitized server-event types.
4. Run the focused test; expect pass.
5. Run typecheck.
6. Commit as `feat: define web socket protocol`.

### Task 3: Add cwd validation and safe public state projection

**Files:**
- Create: `src/server/cwd.ts`
- Create: `src/server/cwd.test.ts`
- Create: `src/server/pi-state.ts`
- Create: `src/server/pi-state.test.ts`

**Steps:**
1. Write failing tests for empty, missing, file, and valid directory paths.
2. Write failing tests proving provider/model projections include display metadata and auth state but never credential values.
3. Implement canonical cwd validation with Node `fs`/`path`.
4. Implement provider grouping from `ModelRegistry.getAll()`, availability from `getAvailable()`, display names/status from registry APIs, and OAuth discovery from `AuthStorage.getOAuthProviders()`.
5. Run focused tests and typecheck; expect pass.
6. Commit as `feat: expose safe pi configuration state`.

### Task 4: Build the native Pi service adapter

**Files:**
- Create: `src/server/pi-service.ts`
- Create: `src/server/pi-service.test.ts`

**Steps:**
1. Write failing tests with injected fake SDK collaborators for initialization, in-memory session creation, model selection, thinking selection, prompt, abort, disposal, and settings flush.
2. Verify the initial test failure.
3. Create shared `AuthStorage.create()` and `ModelRegistry.create(authStorage)` instances.
4. For each connection, create `SettingsManager.create(cwd)`, select the native default/first available model, and call `createAgentSession({ cwd, authStorage, modelRegistry, settingsManager, sessionManager: SessionManager.inMemory(cwd) })` without replacing Pi's default tools.
5. Forward native Pi session events without transforming secret-bearing data.
6. Implement `session.setModel()`, `session.setThinkingLevel()`, `session.prompt()`, `session.abort()`, and `session.dispose()`.
7. Persist model and thinking through native `SettingsManager` setters plus `flush()`.
8. Run focused tests and typecheck; expect pass.
9. Commit as `feat: integrate pi agent sdk`.

### Task 5: Implement API-key and OAuth authentication

**Files:**
- Create: `src/server/auth-flow.ts`
- Create: `src/server/auth-flow.test.ts`
- Modify: `src/server/pi-service.ts`

**Steps:**
1. Write failing tests proving API keys are persisted with `AuthStorage.set()`, never emitted, and logout uses native storage.
2. Write failing tests for every `OAuthLoginCallbacks` branch: auth URL, device code, prompt, select, progress, manual code, cancellation, completion, and failure.
3. Implement a request-id-based callback broker with pending-promise cleanup and `AbortController`.
4. Call `authStorage.login(providerId, callbacks)` for providers discovered from `getOAuthProviders()`.
5. After auth changes, call `authStorage.reload()` and `modelRegistry.refresh()` and publish fresh sanitized state.
6. Drain and report native auth/settings errors safely.
7. Run focused tests and typecheck; expect pass.
8. Commit as `feat: support native pi authentication`.

### Task 6: Implement the loopback WebSocket server

**Files:**
- Create: `src/server/socket-server.ts`
- Create: `src/server/socket-server.test.ts`
- Modify: `src/server/index.ts`

**Steps:**
1. Write failing integration tests for loopback startup, origin rejection, initialization, prompt dispatch, auth response correlation, malformed commands, and cleanup on close.
2. Implement Express health/static routes and attach `WebSocketServer` in `noServer` mode.
3. Accept only expected localhost origins and enforce payload limits.
4. Validate all messages with the shared schema before dispatching to the Pi adapter.
5. Serialize mutating commands and emit typed safe errors.
6. Dispose the session and cancel OAuth on socket close.
7. Run server tests, typecheck, and build; expect pass.
8. Commit as `feat: add local pi web server`.

### Task 7: Build the setup and connection experience

**Files:**
- Create: `src/client/lib/socket.ts`
- Create: `src/client/lib/storage.ts`
- Create: `src/client/components/Setup.tsx`
- Create: `src/client/components/ConnectionDrawer.tsx`
- Create: `src/client/components/AuthDialog.tsx`
- Create: `src/client/components/ModelPicker.tsx`
- Create: `src/client/components/Setup.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Steps:**
1. Write failing component tests for remembered cwd, validation feedback, provider status, key submission clearing, OAuth prompts, logout, model search/grouping, and model selection.
2. Implement a reconnect-aware typed WebSocket client.
3. Store only `piweb.lastCwd` in localStorage.
4. Implement setup, provider authentication, OAuth callback dialogs, searchable model picker, and thinking selector.
5. Ensure secrets are cleared from component state immediately after submission.
6. Run focused client tests and typecheck; expect pass.
7. Commit as `feat: add pi setup and authentication ui`.

### Task 8: Build the ephemeral chat experience

**Files:**
- Create: `src/client/chat/reducer.ts`
- Create: `src/client/chat/reducer.test.ts`
- Create: `src/client/components/Chat.tsx`
- Create: `src/client/components/Message.tsx`
- Create: `src/client/components/ToolCard.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Steps:**
1. Write failing reducer tests for user messages, streaming text/thinking, tool start/update/end, errors, abort, and settled state.
2. Implement deterministic projection of native Pi events into UI transcript items.
3. Implement Markdown rendering with DOMPurify sanitization.
4. Implement multiline composer, Enter/Shift+Enter behavior, send/stop button, auto-scroll, collapsed thinking, and collapsed tool output.
5. Reset transcript when cwd/session changes and never write messages to storage.
6. Run focused tests and typecheck; expect pass.
7. Commit as `feat: add ephemeral pi chat ui`.

### Task 9: Polish errors, accessibility, and responsive layout

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: relevant component tests

**Steps:**
1. Add tests for keyboard focus, accessible labels, offline state, empty model state, busy controls, and auth cancellation.
2. Implement clear loading/offline/error banners and focus management.
3. Finish compact light/dark-aware responsive styling without adding a UI framework.
4. Run all client tests and typecheck; expect pass.
5. Commit as `fix: harden pi web user experience`.

### Task 10: Document and verify the release

**Files:**
- Create: `README.md`
- Modify: `.gitignore`

**Steps:**
1. Document Node requirements, install/start commands, loopback-only behavior, cwd behavior, native Pi config reuse, OAuth flow, and ephemeral conversations.
2. Run `npm test`; expect all tests pass.
3. Run `npm run typecheck`; expect no errors.
4. Run `npm run build`; expect server and client production builds.
5. Start the production server and verify `/health` plus the browser flow manually.
6. Confirm no session JSONL file is produced and no secret appears in server/client output.
7. Commit as `docs: document minimal pi web ui`.
