# Minimal Pi Web UI Design

## Goal

Build a local-only, minimal, usable web interface for Pi in `E:\piweb`. The first release provides an ephemeral coding-agent conversation, Pi-native provider authentication, model selection, streaming output, and Pi's default coding tools. Conversation history is never written to disk.

## Product decisions

- Bind the server to `127.0.0.1` only.
- Use the official `@earendil-works/pi-coding-agent` SDK directly.
- Reuse Pi's global `auth.json`, `models.json`, and `settings.json` through public SDK classes.
- Support every API-key provider exposed by Pi and every OAuth provider returned by `AuthStorage.getOAuthProviders()`.
- Use `SessionManager.inMemory(cwd)` so conversations are ephemeral.
- Enable Pi's default tools (`read`, `bash`, `edit`, and `write`) and standard resource discovery.
- Let the user enter a working directory. Remember only this UI preference in browser local storage.
- Persist the selected provider/model with `SettingsManager.setDefaultModelAndProvider()`.
- Do not duplicate provider catalogs, model catalogs, credential resolution, model calls, tools, retries, or session behavior.

## Architecture

### Client

A React/Vite single-page application with three views:

1. **Setup** — working-directory input, validation, and start button.
2. **Chat** — message transcript, compact tool activity cards, streaming status, stop action, and multiline composer.
3. **Connection drawer** — provider authentication status, API-key login/logout, OAuth login/logout, searchable model selection, and thinking-level selection.

The client stores only the last working-directory string in `localStorage`. It never stores API keys or messages.

### Server

A long-lived Node.js process owns one active `AgentSession` per browser connection. It exposes:

- small HTTP endpoints for health and static assets;
- a WebSocket endpoint for commands, Pi events, authentication interaction, and state snapshots.

The server creates shared native services:

- `AuthStorage.create()` for `~/.pi/agent/auth.json`;
- `ModelRegistry.create(authStorage)` for Pi built-ins and `~/.pi/agent/models.json`;
- a cwd-specific `SettingsManager.create(cwd)`;
- `SessionManager.inMemory(cwd)` for each active session;
- `createAgentSession()` with the selected model and standard Pi defaults.

Changing cwd disposes the old session and creates a fresh in-memory session. Closing/reloading the page disposes its session and loses its messages.

## Native Pi integration

### Providers and models

Provider rows are derived by grouping `ModelRegistry.getAll()` by provider. Display names come from `ModelRegistry.getProviderDisplayName()`. Availability and credential labels come from `ModelRegistry.getProviderAuthStatus()`. Models shown as ready come from `getAvailable()`; unavailable models remain discoverable under their provider so the user understands what authentication unlocks.

After credentials change, call `authStorage.reload()` and `modelRegistry.refresh()`, then emit a fresh state snapshot.

### API-key authentication

Save credentials with:

```ts
authStorage.set(provider, { type: "api_key", key })
```

Logout uses `authStorage.logout(provider)`. The server never serializes a credential value back to the client. Existing environment, fallback, command-backed, custom-provider, and stored credential resolution remains owned by Pi.

### OAuth subscriptions

The available subscription providers are discovered from `authStorage.getOAuthProviders()`, not hard-coded. Login uses `authStorage.login(providerId, callbacks)`.

Callback handling is mapped to WebSocket events:

- `onAuth`: show/open the authorization URL and instructions;
- `onDeviceCode`: show user code and verification URL;
- `onPrompt`: render a text prompt and return the response;
- `onSelect`: render options and return the selected id;
- `onProgress`: update visible login progress;
- `onManualCodeInput`: request a manual callback code when needed;
- `AbortSignal`: cancel login when the user closes the dialog.

### Selected model and thinking

Model switching uses `modelRegistry.find(provider, modelId)` followed by `session.setModel(model)`. Successful selection is persisted through `settingsManager.setDefaultModelAndProvider(provider, modelId)` and `await settingsManager.flush()`.

Thinking levels use `session.setThinkingLevel(level)` and native model capability information. The chosen level is persisted with `settingsManager.setDefaultThinkingLevel(level)`.

### Agent session

Create sessions with `SessionManager.inMemory(cwd)`. Subscribe directly to `AgentSession` events. Text and thinking deltas update the active assistant message. Tool start/update/end events update compact tool cards. `agent_settled` or the session promise completion returns the UI to idle. Stop calls `session.abort()`.

## WebSocket protocol

The adapter protocol is intentionally small and typed.

Client commands:

- `initialize { cwd }`
- `prompt { text }`
- `abort`
- `select_model { provider, modelId }`
- `set_thinking { level }`
- `set_api_key { provider, key }`
- `login_oauth { provider }`
- `logout { provider }`
- `auth_response { requestId, value | selectedId | cancelled }`
- `cancel_auth`
- `refresh_models`

Server events:

- `state` — sanitized providers, models, selected model, thinking level, cwd, and busy state;
- `session_event` — selected native Pi events needed for rendering;
- `auth_request` / `auth_progress` / `auth_complete`;
- `error` — safe, actionable error text.

Credentials are accepted only in the inbound `set_api_key` command and are never logged or echoed.

## User experience

- On first launch, focus the cwd field and offer the server startup cwd as the default.
- Validate that cwd exists and is a directory before creating a session.
- If no provider is authenticated, open the connection drawer automatically.
- Group models by provider and add search. Put available models first.
- Mask authentication state as labels such as “Stored key”, “Environment”, or “Subscription”; never show secret fragments.
- Enter sends; Shift+Enter inserts a newline.
- While running, the send button becomes Stop.
- Render Markdown for assistant text and plain text for user text.
- Collapse thinking and tool output by default, while retaining visible status and errors.
- Provide clear empty, loading, offline, login-progress, invalid-directory, no-model, aborted, and provider-error states.
- Keep the visual style neutral and compact: one centered conversation column, restrained borders, accessible contrast, and responsive behavior.

## Error handling and security

- Listen only on loopback and reject unexpected `Origin` headers.
- Set a strict request-body/message-size limit.
- Validate every WebSocket command with a schema.
- Do not log inbound key payloads.
- Serialize operations that mutate auth/settings and report `drainErrors()` results.
- Surface `modelRegistry.getError()` without hiding the built-in model list.
- Dispose sessions and abort active OAuth flows on socket close.
- Handle malformed Pi events defensively without terminating the server.
- Use Pi's own file locking for auth and settings persistence.

## Testing

- Unit-test command schemas, provider/model sanitization, auth callback correlation, message projection, and cwd validation.
- Integration-test with in-memory `AuthStorage`, `ModelRegistry`, and `SettingsManager` where possible.
- Verify that no session file is created and that credentials are never emitted to clients.
- Test model persistence, key add/remove, OAuth callback flows with a fake provider, streaming text, tool event updates, abort, reconnect, and invalid input.
- Build the client and run server tests as the release gate.

## Out of scope for v1

- Persistent or resumable conversations
- Multiple tabs sharing one conversation
- File/image attachments
- Session tree, compaction controls, exports, and usage dashboards
- Remote/LAN/public deployment
- A custom provider editor (Pi's `models.json` remains the source of truth)
- Reimplementation of Pi TUI-only dialogs or settings screens
