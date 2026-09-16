# 自定义提供商

`updated: 2026-09-16`

## 这个模块是干什么的

让用户在工作台里定义与编辑本机或自建的 OpenAI 兼容模型端点（LM Studio、llama.cpp、vLLM、Ollama 等），并把结果写成 Pi 自己的用户级 `<Pi agent dir>/models.json`。

- 不负责：凭据存储（走「模型连接」→ `auth.json`）、会话模型选择（由角色快照冻结）、“模型连接”里远程供应商的目录刷新（`refresh_models`）以及 Pi CLI 自己的配置管理。
- 工作台不引入第二份 provider 格式：`models.json` 是工作台与 `pi` CLI 共享的唯一真相；工作台只是它的受控编辑器与目录刷新触发器。

## 架构

```text
设置页「自定义提供商」
  → refresh_custom_providers / save_custom_provider / delete_custom_provider
    / probe_custom_provider_models（连接级 socket control，无 sessionId）
  → CustomProviderStore（<Pi agent dir>/models.json）
  → PiRuntime.updateConfiguration（共享配置串行队列）
  → ModelRuntime.refresh() 重读 models.json → 基线 + 每个 session/project 模型目录 → notify
  → custom_providers_snapshot（未来源 commandId 为写盘回执）/ custom_provider_models_probe
```

- 读：基线 `ModelRegistry` 与每个 session 的 registry 都用 SDK 默认 `modelsPath=<agentDir>/models.json`；`updateConfiguration/refreshConfiguration` 会重新 `ModelConfig.load(modelsPath)` 并重组 provider，因此写完文件后所有已打开会话与角色可用性在同一帧收敛，无需重启。
- 写：`CustomProviderStore` 只改写 `providers.<id>` 那段文本，其它 provider、注释、缩进与未知字段逐字节保留；以文件原始字节 sha256 作 revision 做 CAS，过期写入拒绝；落盘前自检（重新去注释/尾逗号解析并比对期望结构）再原子替换（同目录 `wx` 临时文件 + rename，保留原 mode）。
- 探测：`probeOpenAiCompatibleModels(baseUrl)` GET `${baseUrl}/models`（不带认证头、1 MiB 响应上限、8 秒总 deadline），同时接受 OpenAI `{data:[]}` 与 LM Studio 原生 `{models:[]}` 形状；随后 best-effort 用 `<origin>/api/v1/models` 富化 contextWindow / name / reasoning / input。

## 决策

1. 真相 = `<agentDir>/models.json`（与 `pi` CLI 共享）。被否的备选是工作台自建 `providers.json` + 静态 extension provider 注册：CLI 看不到、要复制 SDK 校验逻辑、等于维护第二份真相。
2. 表单只写能忠实表示的字段：provider 级 `name/baseUrl/api/apiKey` 形态，model 级 `id/name/contextWindow/maxTokens/reasoning/input`。`headers/compat/authHeader/modelOverrides/oauth/cost/samplingParams/thinkingLevelMap` 等既有一律保留，并作为 `extraFields` 告知用户；形状不完整（无 baseUrl、api 不在四种内、models 为空或元素非对象）或重叠内置 provider 的条目 `editable=false`，只能直接编辑文件。
3. 内置 provider id（`@earendil-works/pi-ai/providers/all` 的 `builtinProviders()`）不可被表单覆盖：只投影 `builtinOverride=true`。否则表单会把 baseUrl/api 强加成对内置 provider 的全局覆盖。
4. 密钥分层：表单在文件里只写「本地占位字面量 `piweb-local`」或 `$ENV`；`credential` 表示不写 apiKey、改用 `auth.json`（凭据优先级高于文件内 apiKey）；既有 literal/command 只报告形态（`storedAuth`）绝不回传值，编辑默认 `keep` 原样保留。
5. 客户端按需拉取（`refresh_custom_providers`），服务端不主动推送；只有 save/delete 成功后才广播快照。连接时无脑推送会打乱既有事件序列，也会把文件读取塞进握手路径。
6. 写盘必须位于 `PiRuntime.updateConfiguration` 的共享配置队列内：`models.json` 与凭据同属进程级模型配置，写入后的刷新与通知也在同一串行边界完成。写入失败与刷新失败同时发生时，回执优先报告写入失败的具体原因。
7. 探测得到的模型 id 必须满足线协议上限（≤256 字符），超出即丢弃：宁可少列一个模型，也不能发出一个会被发送边界判为非法并以 4002 关闭连接的事件。

## 认知模型

`models.json` 是用户级的 Pi provider 定义；工作台只做两件事：受控编辑它，以及触发 Pi 的目录重读。凭据、模型选择、工具权限仍各归原有 owner。

判据：任何“把端点元数据写进文件”的自动化都必须是**用户可覆盖、可解释的快照**，不能伪装成活连接；端点重新加载模型后 context 等值会变，文件不会自己跟着变。

## 入口

- `src/server/custom-provider-store.ts` — 读投影、外科写盘、revision CAS、原子写、自检
- `src/server/custom-provider-probe.ts` — `/models` 探测与端点元数据富化
- `src/server/socket-server.ts` — `handleCustomProviderCommand`、连接级 admission/去重、错误与广播
- `src/server/index.ts` — 真实 store 的 `modelsPath` 与 `builtinProviderIds` 注入
- `src/shared/protocol.ts` — v60 的命令与事件
- `src/client/components/SettingsDrawer.tsx`、`src/client/App.tsx` — 设置页与命令关联
- 测试：`custom-provider-store.test.ts`、`custom-provider-probe.test.ts`、`socket-server.test.ts`、`protocol.test.ts`、`SettingsDrawer.test.tsx`、`App.test.tsx`

## 坑点

- 不要整份重写 `models.json`：会丢注释（Pi 支持 `//` 行注释与尾逗号，不支持 `/* */`）、其它 provider 与高级字段。只有目标条目会被重新序列化，且删除成员时要正确收拾逗号。
- 文件损坏、超 4 MiB、顶层或 `providers` 非对象时必须 fail closed：`read` 返回带 `error` 的空快照，`save/delete` 拒绝写盘并且不留下临时文件。
- `CustomProviderStore.memory()` 是只读实例（save/delete 必抛），socket-server 的默认参数故意用它以免测试误写用户文件；生产必须由 `index.ts` 注入真实 store。
- 不要把 apiKey 值放上线协议：wire schema 没有该字段，靠投影保证只出现 `storedAuth` 形态与变量名。
- contextWindow 必须对齐端点**实际加载**的配置：LM Studio 的模型可能宣称 262144，而 loaded context 是 29696 或 182272；写大了会被服务端拒绝（Pi 能识别 llama.cpp/LM Studio 的溢出文案并自动压缩重试，代价是一轮失败），写小了只是少用上下文。探测值只是写入时的快照，端点上重新加载模型后需要再次探测或手改。
- 通用 OpenAI 兼容 `/v1/models` 只有 `id/object/owned_by`，没有上下文或能力字段；只有 LM Studio 原生接口这类额外端点才提供。其它实现的拿法各不相同（vLLM/SGLang 在 item 上带 `max_model_len`、llama.cpp 有 `/props`、Ollama 需要 POST `/api/show`、TGI 有 `/info`），不要假定一个通用形状。
- 探测失败（连接错误、非 JSON、两种形状都不匹配）必须以 error 回告，不能谎报为空列表；只有富化失败才静默降级——探测结果只允许被补充，不允许被富化请求破坏。
- 本地端点离线时模型仍可能显示 available（只要有文件内占位或 `auth.json` 凭据）：这是 Pi 的语义，请求失败在运行时呈现。

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
