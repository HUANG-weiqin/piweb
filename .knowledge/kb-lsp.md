# 本机 LSP 查询

`updated: 2026-09-12`

## 支持边界

LSP 接入是服务端的工作区资源，不是 Pi 内核扩展、浏览器 IDE 或第二套索引。只连接用户预先安装的本机 `stdio` 语言服务器，固定三个 `source=sdk` 工具：

| 工具 | 参数 | 含义 |
|---|---|---|
| `lsp_symbols` | `path, scope, query?, limit?` | 文档符号或所在语言服务根的工作区符号 |
| `lsp_definition` | `path, line, column, limit?` | 定义位置 |
| `lsp_references` | `path, line, column, includeDeclaration?, limit?` | 引用位置，默认不含声明 |

`path` 必须是当前工作区内的现存常规源文件，同时作为服务器和 root 的选择锚。行、列均从 1 开始，列按 UTF-16 code unit 计数。磁盘源码只接受有效 UTF-8（保留 BOM 的字符位置）；不创建 Agent 私有编辑缓冲区。初始化只声明 UTF-16，服务器选择其它编码时拒绝连接。

没有 raw request、任意 command/method、诊断订阅工具、rename、workspace edit、安装器、daemon 或虚拟源码获取。`workspace/applyEdit` 总是返回 `applied:false`。服务器 URI/range 和响应后读取的磁盘片段是两个观察事实；`disk.observation=read_after_response` 不是范围仍有效或索引已完成的证明。虚拟 URI、非本机 file URI、工作区外文件只保留引用和不可读原因，不读其内容，也不制造坐标或永久符号 ID。

## 所有权与调用顺序

```text
ConversationActor 的 workbenchCustomTools
→ 最终 SDK 来源/角色 host gate
→ ProjectContext 直接惰性持有 WorkspaceLsp（无信任询问）
→ 先解析配置、root 与查询适用性，再创建/等待工作区 watcher
→ canonical root + resolved configuration fingerprint 选共享连接
→ 短串行门：磁盘复核、didOpen/change/save/close、watch 通知、请求派发
→ 门外等待响应
→ 复核目标与已观察变化
→ 工具输出有界位置和独立磁盘片段
```

- 同一 canonical workspace 的多个 actor 可共享同一 root/config；不同 `WorkspaceLsp` 实例绝不共享进程。冻结配置指纹包含真实可执行路径、完整 argv、有效 env、语言映射、初始化选项、settings、静态 watch 声明和 adapter version。
- caller 取消只撤销本次等待并发送 `$/cancelRequest`，不关闭其他 actor 正在使用的进程。初始化由池自己拥有；不能把第一个调用者的 AbortSignal 变成共享启动信号。
- 不把响应等待放进串行门；反向 RPC 也独立处理，避免请求互相堵住。被取消但尚无 wire response 的请求仍计入 pending cap，迟到响应仅释放对应 slot。
- focus、断线、actor 角色重建或单个 actor 关闭不释放工作区服务。coordinator 关闭先封 LSP admission，等待 actor teardown，再 dispose 工作区。空闲连接会回收；没有后台自动重试或持久化 LSP 状态。
- 清理先标准 shutdown/exit，再有界强停。Windows 的进程树强停只在自有父进程仍存活时有 `taskkill /T` 证明；父进程先退出且子进程脱离 stdio 的 daemon/launcher 不属于支持范围。没有 Windows Job Object 或跨进程 PID 跟踪，不能声称 OS 级隔离或无条件回收逃逸后代。
- watcher 已知的 root 内同语言源文件 change，先通过已有有界镜像发送最新 didOpen/didChange，最后才同步并派发本次 target；不预读或预开整个项目的源码。watcher 本身会递归注册工作区目录，不承诺目录数量或首次 ready 耗时与工作区大小无关。add/unlink 仍需项目成员通知，unlink 还会关闭已有镜像。watch 覆盖同时校验 glob 与事件的 WatchKind；派发记录已处理游标，而非尚未同步的最新事件号。
- 已知变化若不能通过实际 opened-document 同步或有效的静态/动态 watch 通知覆盖，连接被标记为不可安全使用：既不接受新借用，也拒绝已借用的排队派发和旧响应，不能因 watch 游标已推进而跳过失败事件。配置 fingerprint 变更则只让旧 entry 退休，仍允许旧配置的在途调用合法完成；这两种生命周期不得混用。真正退出/启动失败有有界的同配置冷却，下一次显式查询才可重连。

## 信任与工具权限

`read_only` 和 `full_access` 都可使用三个工具，但只读角色只能使用最终来源为 SDK 的宿主工具；同名 builtin/project/extension 工具不能冒充。

用户级配置中已启用的语言服务允许所有角色直接使用，不查询或写入 Pi project trust store，不读取全局 `defaultProjectTrust`，也不弹信任询问。已有项目拒绝决定不阻止 LSP；项目设置、skills 和 extensions 仍走独立的原信任检查。未配置或禁用的服务器仍不可用，项目内文件不能提供 LSP 配置。

语言服务可能执行 MSBuild、加载插件或写缓存；只读查询不等于进程、文件系统或网络 sandbox。共享服务器启动仍属于工作区，caller 取消只影响本次查询。没有新增 trust 类别、角色字段、浏览器命令或持久 schema。

## 用户级配置

文件位置：`<Pi agent dir>/piweb/lsp.json`，通常为 `~/.pi/agent/piweb/lsp.json`。工作台只读取，不自动创建；没有配置就是 `not_enabled`。项目内的配置不参与解析。配置拒绝发生在 watcher 分配和 ready 等待之前，不会为未启用/错误配置创建递归 watcher，也不会被该 watcher 的启动超时遮蔽。

```json
{
  "version": 1,
  "servers": [
    {
      "id": "roslyn",
      "workspace": "E:/projects/example",
      "command": [
        "E:/tools/roslyn/roslyn-language-server.exe",
        "--stdio",
        "--autoLoadProjects"
      ]
    }
  ]
}
```

- 条目存在即 opt-in；`enabled:false` 禁用。`workspace` 可省略，表示适用于所有工作区；同 ID 的精确 workspace 条目替代全局条目，同作用域重复 ID 拒绝。
- 内置 profile 提供默认 command、语言映射、root markers、初始化选项和 settings。配置中的字段整体替换对应 profile 字段，不做隐式深合并。带局部 `adaptConnection` 的 profile 以其 `id` 绑定服务器语义：可省略 `extensionToLanguage` 并继承默认映射；一旦显式提供，键和值必须与该 profile 的完整映射完全相等，增删或改写均以 `misconfigured` 拒绝。`command`、argv、env、root 等部署字段仍可覆盖；用户 JSON 不能选择或提供适配器代码。
- 支持字段：`id / enabled / workspace / command / env / extensionToLanguage / rootMarkers / root / initializationOptions / settings / watchFiles`；未知字段拒绝。
- 自定义语言服务器同样是数据条目，须给出 command、扩展名到 language ID 的映射，以及 root 或 rootMarkers。无需改工具、传输或工作区类。
- command 是可执行程序和字面 argv，不是 shell 字符串。只接受绝对可执行路径或 PATH 名称，拒绝 `.cmd/.bat/.ps1` 和相对可执行路径；Windows 的 npm 包应使用 `node.exe + 绝对 JS 入口 + argv`。环境继承宿主环境，再应用用户声明的 env，并进入冻结指纹。
- `rootMarkers` 是有优先级的 basename glob 分组：先在文件到 workspace 的祖先中搜索第一组，再搜索后续组。只在 workspace 内发现 root；同层多个 marker 或多个匹配服务器都拒绝猜测。`root` 显式选择目录，但不等价于命令服务器打开某个 solution。若服务器自身不能确定选择，应选择独立项目目录，或使用该服务器明确支持的启动/初始化参数。
- 配置每次查询重新读取、严格验证和深快照；修改配置只影响后续借用，不能中止旧配置正在服务的调用。`watchFiles` 只能声明已核验的标准 `didChangeWatchedFiles` 路径，不能用它假装服务器支持通知。

## 语言声明

### C#

内置 `roslyn` 使用官方 `roslyn-language-server --stdio --autoLoadProjects`，匹配 `.cs → csharp`，root 优先 `.sln/.slnx` 再 `.csproj`。服务器及匹配的 .NET 运行时由用户独立安装，不属于 Pi Web npm 依赖。被分析项目还需可用的 SDK、targeting packs 与已 restore 的项目依赖；宿主不代替项目执行 restore/build。普通 `.cs` 是首个支持范围；虚拟生成源码和反编译 URI 不会被工作台读取。

Roslyn 5.12 的定义导航优先使用 frozen partial semantics，单独 watcher 或文本同步不能证明跨文件语义已更新。`servers/roslyn.ts` 的局部适配器在 definition 前对同位置执行一次 references（含声明），准备完整语义后才发 definition；不是重试。两阶段保留同一 caller signal、共享连接、wire/总时限与门外等待，准备期间另一调用者同步文档则返回 `content_modified`。references 和 symbols 本身仍是单次请求。适配器仅来自受信内置 profile，在初始化的清理边界内绑定；用户 JSON 不能提供可执行适配代码。

### TypeScript / JavaScript

内置 `typescript` 使用 `typescript-language-server --stdio`，不是 raw `tsserver`。映射为 `.ts/.mts/.cts → typescript`、`.tsx → typescriptreact`、`.js/.mjs/.cjs → javascript`、`.jsx → javascriptreact`。root 优先 `tsconfig.json/jsconfig.json` 同组，再回退 `package.json`；同层同时存在两个配置 marker 时仍拒绝猜测，可显式配置 `root`。

例如在 `servers` 中增加一个 Windows 工作区条目：

```json
{
  "id": "typescript",
  "workspace": "E:/projects/web",
  "command": [
    "C:/Program Files/nodejs/node.exe",
    "C:/tools/tls/node_modules/typescript-language-server/lib/cli.mjs",
    "--stdio"
  ]
}
```

TLS 及可用的 TypeScript 库由用户独立准备；不会加入 Pi Web 的运行依赖或修改全局 PATH。profile 没有局部适配器，也不臆造静态 watch 覆盖。已知源文件内容变化复用通用有界 mirror；add/delete/config 等变化若缺少实际同步覆盖，按通用规则失效旧连接并由后续显式查询重建，不能把服务器自己的文件观察当作宿主已确认的同步。

新增语言只修改 `src/server/lsp/servers/` 内的声明或必要局部适配；不得在 tools、workspace 或 connection 根据语言名称分支。

## 磁盘读取绑定

初始 target、镜像复核、watch 同步与响应后片段统一经过 `read-workspace-file.ts`。授权 namespace 来自 `ProjectContext` 已冻结的 canonical cwd；首查询只能验证它仍解析到自身，响应投影也不能再次 `realpath(cwd)` 把整个 cwd 的 junction 替换认成新工作区。路径 `realpath/stat` 只用于选择，不能授权之后按相同字符串重新打开得到的对象。读取器打开一个 fd 后，先从该 fd 获取实际路径，要求它与预期 canonical 文件精确一致且位于冻结的 canonical workspace/root 内，然后仅用这个 fd 做常规文件检查、有界读取和 BigInt `fstat`。读取后再次绑定路径、复核 identity/size/mtime/ctime，通过后才交给调用者解码；被换为外部 junction/symlink、移动、变化或无法证明的结果不返回源码。POSIX 打开使用 nonblocking 标志，避免 regular file 被换成 FIFO 后卡在 open。

- Windows：通过当前 Node 进程导出的 `uv_get_osfhandle` 使用 Node 自己的 CRT fd 表，再调用 `GetFinalPathNameByHandleW`；不能换成另一份 `ucrtbase.dll` 的 `_get_osfhandle`。只处理可比较的规范 DOS/UNC 路径，保持 canonical 大小写精确一致，不用小写折叠合并大小写敏感目录。只由 Node `FileHandle.close()` 关闭 fd，不另行 `CloseHandle`。
- Linux：读取 `/proc/self/fd/<fd>` 的内核链接，不按返回路径重开文件；缺少可用 procfs 或已删除/不匹配的路径即拒绝。
- Darwin：通过现有 Koffi 调用 libSystem 的 `fcntl(fd, F_GETPATH)`，要求 1024-byte 上限内的有效、NUL 结尾 UTF-8 路径。原生失败不能回退为无绑定的路径读取。
- 其它未实现可靠 fd 路径绑定的平台（例如 FreeBSD）或原生能力缺失返回 `unavailable`，不静默读文件。这里不是 OS sandbox、全项目原子快照、hard-link 隔离或对任意并发内容写入的事务保证；磁盘片段仍只是独立的读取观察。

## 有界性与失败语义

- 用户配置最多 64 KiB、32 个声明；根查找有目录层数和单目录 entry 上限。
- 每工作区最多 8 个连接；每连接最多 64 个 wire pending；反向 configuration 单次最多 128 项（官方 Roslyn 初始化会请求 75 项），动态注册/反注册每批及注册存量最多 64 项、watcher 最多 256 项。默认初始化 60 秒、单 RPC 20 秒、工作区查询总等待 90 秒。
- 已打开文档镜像最多 64 个、单文件 2 MiB、合计 16 MiB；只保留同步所需文本/hash/version，不是第二套索引。更新也检查总量，不只检查首次打开。
- watcher 队列有界，error/overflow 使现有 generation 失效。默认排除 `.git/.piweb/node_modules` 树；显式 target 和已打开文档仍逐次复核，不承诺覆盖被排除的依赖目录、远程文件或全项目原子快照。
- 每次默认输出 30 条，最多 100 条；最终序列化 JSON 最多 24 KiB。名称/片段/列表截断均明确标记。磁盘片段单文件最多读取 2 MiB、单次总量 4 MiB。
- `ok` 加空 items 仅代表成功的空结果。`unsupported / not_enabled / misconfigured / unavailable / timeout / cancelled / content_modified / resource_limit / invalid_path / ambiguous_server` 分别表达失败原因；工具抛异常让 SDK 标 `isError`，不能把失败变成空列表。

## 代码与验证入口

- `src/server/lsp/contracts.ts`：纯服务端内部合同。
- `definition.ts`、`servers/`：用户声明、根/可执行解析、深快照与指纹。
- `connection.ts`：微软 JSON-RPC stdio、能力、反向 RPC、取消和进程清理。
- `workspace.ts`：共享池、短串行门、磁盘同步和 watcher。
- `read-workspace-file.ts`：共享的 fd/path 绑定与有界源码读取。
- `tools.ts`：三个 SDK 工具与有界投影。
- 对应 `*.test.ts` 分别证明配置边界、真实 fake-stdio 协议、工作区竞态/磁盘同步和结果边界；coordinator/policy 测试证明宿主所有权、无交互直接查询与来源 gate；runtime 测试保留项目 SDK 资源的信任检查。

## 真服务器 fixture

`roslyn.integration.test.ts` 默认跳过，只有显式提供私有工具入口才会启动。当前 fixture 使用官方 `roslyn-language-server 5.12.0-1.26426.8` 的 Windows apphost、.NET 10 运行时和本机可用的 .NET 8 SDK/targeting packs；服务器运行时与被分析项目的 SDK 是不同前置条件。测试创建并删除私有多文件项目，NuGet 配置清空源，并在启动 watcher/LSP 前显式离线 restore 该 fixture；不安装服务器、不改全局工具链或用户 LSP 配置。

```bash
PIWEB_LSP_ROSLYN_COMMAND='["C:/tools/roslyn/Microsoft.CodeAnalysis.LanguageServer.exe","--stdio","--autoLoadProjects"]' \
PIWEB_LSP_ROSLYN_DOTNET_ROOT='C:/tools/dotnet10' \
npx vitest run src/server/lsp/roslyn.integration.test.ts
```

fixture 的启动与项目加载有界轮询是显式的后续工具调用，不是运行时自动重试；`initialize` 不承诺索引已就绪。已关闭 Helper 的变更验收则在真实 watcher 观察到 change 后只调用一次 definition，要求新范围、最新文本已同步且连接未重建；不以独立的磁盘片段更新冒充索引同步。

`typescript.integration.test.ts` 同样默认跳过，显式传入真实 TLS 的 argv 后运行私有多文件 fixture；测试不安装工具、不修改用户配置。验证版本为 `typescript-language-server 4.3.3` 与 TypeScript `5.7.3`。第二语言只增加声明、目录注册与测试，不修改通用传输、工具、工作区或会话层。

```bash
PIWEB_LSP_TYPESCRIPT_COMMAND='["C:/Program Files/nodejs/node.exe","C:/tools/tls/node_modules/typescript-language-server/lib/cli.mjs","--stdio"]' \
 npx vitest run src/server/lsp/typescript.integration.test.ts
```

关联：[服务端运行时](kb-server-runtime.md)、[工具权限](kb-tool-policy.md)。
