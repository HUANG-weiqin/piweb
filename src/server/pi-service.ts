import {
  AuthStorage,
  createAgentSession,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ClientCommand, PublicState, ServerEvent, ThinkingLevel } from "../shared/protocol.js";
import { AuthFlowBroker } from "./auth-flow.js";
import { validateCwd } from "./cwd.js";
import { buildPublicProviders } from "./pi-state.js";

export class PiConnection {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private session?: AgentSession;
  private settings?: SettingsManager;
  private cwd?: string;
  private unsubscribe?: () => void;
  private authFlow?: AuthFlowBroker;

  constructor(private readonly emit: (event: ServerEvent) => void) {}

  async initialize(inputCwd: string): Promise<void> {
    const cwd = await validateCwd(inputCwd);
    await this.disposeSession();
    this.cwd = cwd;
    this.settings = SettingsManager.create(cwd, getAgentDir());
    const { session } = await createAgentSession({
      cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settings,
      sessionManager: SessionManager.inMemory(cwd),
    });
    this.session = session;
    this.unsubscribe = session.subscribe((event) => {
      this.emit({ type: "session_event", event });
      if (event.type === "agent_start" || event.type === "agent_settled" || event.type === "agent_end") this.publishState();
    });
    this.publishState();
  }

  async handle(command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "initialize": return this.initialize(command.cwd);
      case "prompt": {
        const session = this.requireSession();
        void session.prompt(command.text).catch((error) => this.fail(error));
        return;
      }
      case "abort": await this.requireSession().abort(); return;
      case "select_model": return this.selectModel(command.provider, command.modelId);
      case "set_thinking": return this.setThinking(command.level);
      case "set_api_key": return this.setApiKey(command.provider, command.key);
      case "login_oauth": return this.loginOAuth(command.provider);
      case "logout": return this.logout(command.provider);
      case "auth_response": this.authFlow?.respond(command); return;
      case "cancel_auth": this.authFlow?.cancel(); this.authFlow = undefined; return;
      case "refresh_models": this.modelRegistry.refresh(); this.publishState(); return;
    }
  }

  private async selectModel(provider: string, modelId: string): Promise<void> {
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.requireSession().setModel(model);
    await this.flushSettings();
    this.publishState();
  }

  private async setThinking(level: ThinkingLevel): Promise<void> {
    this.requireSession().setThinkingLevel(level);
    await this.flushSettings();
    this.publishState();
  }

  private async setApiKey(provider: string, key: string): Promise<void> {
    this.assertKnownProvider(provider);
    this.authStorage.set(provider, { type: "api_key", key });
    this.modelRegistry.refresh();
    this.reportNativeErrors();
    this.publishState();
  }

  private async loginOAuth(provider: string): Promise<void> {
    if (!this.authStorage.getOAuthProviders().some((item) => item.id === provider)) throw new Error(`OAuth provider not found: ${provider}`);
    this.authFlow?.cancel();
    const flow = new AuthFlowBroker(this.emit);
    this.authFlow = flow;
    try {
      await this.authStorage.login(provider, flow.callbacks);
      this.modelRegistry.refresh();
      this.emit({ type: "auth_complete", provider });
      this.publishState();
    } finally {
      if (this.authFlow === flow) this.authFlow = undefined;
    }
  }

  private async logout(provider: string): Promise<void> {
    this.assertKnownProvider(provider, true);
    this.authStorage.logout(provider);
    this.modelRegistry.refresh();
    this.reportNativeErrors();
    this.publishState();
  }

  private assertKnownProvider(provider: string, includeOAuth = false): void {
    const modelProvider = this.modelRegistry.getAll().some((model) => model.provider === provider);
    const oauthProvider = includeOAuth && this.authStorage.getOAuthProviders().some((item) => item.id === provider);
    if (!modelProvider && !oauthProvider) throw new Error(`Provider not found: ${provider}`);
  }

  private state(): PublicState {
    if (!this.cwd) throw new Error("Session is not initialized");
    const available = this.modelRegistry.getAvailable();
    const oauthProviders = new Map(this.authStorage.getOAuthProviders().map((provider) => [provider.id, provider.name]));
    return {
      cwd: this.cwd,
      busy: this.session?.isStreaming ?? false,
      selectedModel: this.session?.model && this.modelRegistry.hasConfiguredAuth(this.session.model)
        ? { provider: this.session.model.provider, id: this.session.model.id }
        : undefined,
      thinkingLevel: (this.session?.thinkingLevel ?? "off") as ThinkingLevel,
      availableThinkingLevels: (this.session?.getAvailableThinkingLevels() ?? ["off"]) as ThinkingLevel[],
      providers: buildPublicProviders({
        models: this.modelRegistry.getAll(),
        availableKeys: new Set(available.map((model) => `${model.provider}/${model.id}`)),
        oauthProviders,
        displayName: (provider) => this.modelRegistry.getProviderDisplayName(provider),
        authStatus: (provider) => this.modelRegistry.getProviderAuthStatus(provider),
      }),
      registryError: this.modelRegistry.getError(),
    };
  }

  private publishState(): void {
    if (this.cwd) this.emit({ type: "state", state: this.state() });
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Choose a working directory first");
    return this.session;
  }

  private requireSettings(): SettingsManager {
    if (!this.settings) throw new Error("Choose a working directory first");
    return this.settings;
  }

  private async flushSettings(): Promise<void> {
    await this.requireSettings().flush();
    this.reportNativeErrors();
  }

  private reportNativeErrors(): void {
    for (const error of this.authStorage.drainErrors()) this.emit({ type: "error", message: error.message });
    for (const item of this.settings?.drainErrors() ?? []) this.emit({ type: "error", message: item.error.message });
  }

  private fail(error: unknown): void {
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  private async disposeSession(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.session?.isStreaming) await this.session.abort();
    this.session?.dispose();
    this.session = undefined;
  }

  async dispose(): Promise<void> {
    this.authFlow?.cancel();
    this.authFlow = undefined;
    await this.disposeSession();
  }
}
