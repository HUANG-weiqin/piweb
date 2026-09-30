import type { ReactNode } from "react";
import { PROMPT_IMAGE_PLACEHOLDER } from "../../shared/protocol";
import type { ToolItem } from "../chat/reducer";
import {
  conversationTargetTitle,
  type ConversationTitleLookup,
} from "../lib/conversation-display";
import { ActivitySpinner } from "./ActivitySpinner";
import {
  HistoricalImageLink,
  type HistoricalImageOpenHandler,
} from "./HistoricalImageLink";

type ToolRecord = Record<string, unknown>;

const UNAVAILABLE_IMAGE_PLACEHOLDER = "[图片已省略]";

const META_TOOL_NAMES = new Set([
  "list_roles",
  "list_sessions",
  "current_session",
  "peek_session",
  "request_edit_budget",
  "start_session",
  "send_session_message",
  "wait_for_session",
  "abort_session",
  "delete_session",
]);

const FIELD_LABELS: Record<string, string> = {
  activity: "运行状态",
  addedFiles: "新增额度",
  attention: "需要关注",
  available: "可用",
  blockedAttempts: "拦截次数",
  canManageSessions: "可管理会话",
  cmd: "命令",
  command: "命令",
  content: "内容",
  conversationId: "会话句柄",
  conversationIds: "会话句柄列表",
  createdAt: "创建时间",
  createdBy: "创建者",
  createdByMe: "由我创建",
  cursor: "游标",
  description: "简介",
  details: "详情",
  diff: "变更预览",
  edits: "编辑",
  error: "错误",
  executionId: "执行句柄",
  exitCode: "退出码",
  file: "文件",
  fileCount: "预计文件数",
  glob: "文件范围",
  grantedFiles: "总额度",
  handle: "句柄",
  id: "标识",
  ignoreCase: "忽略大小写",
  kind: "类型",
  lastActiveAt: "最后活跃",
  limit: "数量上限",
  literal: "按原文匹配",
  message: "消息",
  model: "模型",
  name: "名称",
  nextCursor: "下一页游标",
  offset: "起始位置",
  ok: "状态",
  outcome: "结果",
  patch: "补丁",
  path: "路径",
  pattern: "搜索内容",
  preview: "预览",
  provider: "提供商",
  reason: "原因",
  stopReason: "停止原因",
  remainingFiles: "剩余额度",
  result: "结果",
  revision: "版本",
  role: "角色",
  roleId: "角色",
  runId: "运行句柄",
  scope: "查看范围",
  self: "当前会话",
  sessions: "会话",
  state: "状态",
  status: "状态",
  task: "任务",
  timeout: "超时",
  title: "标题",
  touchedFiles: "已修改文件",
  truncated: "内容已截断",
  updatedAt: "更新时间",
};

const FIELD_VALUE_LABELS: Record<string, Record<string, string>> = {
  outcome: {
    edit_budget_granted: "已授予编辑额度",
  },
  kind: {
    cancelling: "正在终止",
    conversation: "Agent 会话",
    idle: "空闲",
    queued: "排队中",
    running: "运行中",
    user: "用户",
    waiting: "等待中",
  },
  state: {
    aborted: "已终止",
    completed: "已完成",
    finished: "已结束",
    in_progress: "后台执行中",
    delivered: "已送达",
    failed: "失败",
    pending: "等待中",
    running: "运行中",
  },
  status: {
    aborted: "已终止",
    completed: "已完成",
    done: "已完成",
    error: "失败",
    failed: "失败",
    idle: "空闲",
    pending: "等待中",
    running: "运行中",
    stopping: "正在停止",
  },
};

function asRecord(value: unknown): ToolRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as ToolRecord;
}

function stringField(record: ToolRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function toolPresentation(
  { name, args }: Pick<ToolItem, "name" | "args">,
  conversationTitleLookup?: ConversationTitleLookup,
): {
  label: string;
  target: string;
} {
  const record = asRecord(args);
  const conversationTarget = () => {
    const conversationId = stringField(record, "conversationId");
    return {
      target: conversationId
        ? conversationTargetTitle(conversationTitleLookup, conversationId)
        : "",
    };
  };
  const conversationTargets = (conversationIds: readonly string[]) => ({
    target: conversationIds.length === 0
      ? ""
      : `${conversationIds.length} 个会话 · ${conversationIds
          .map((conversationId) => conversationTargetTitle(
            conversationTitleLookup,
            conversationId,
          ))
          .join(" · ")}`,
  });
  switch (name) {
    case "read":
      return { label: "读取文件", target: stringField(record, "path") };
    case "bash":
      return { label: "运行命令", target: stringField(record, "command") };
    case "bash_poll":
      return { label: "查询后台命令", target: stringField(record, "executionId") };
    case "bash_stop":
      return { label: "停止后台命令", target: stringField(record, "executionId") };
    case "edit":
      return { label: "编辑文件", target: stringField(record, "path") };
    case "write":
      return { label: "写入文件", target: stringField(record, "path") };
    case "grep": {
      const pattern = stringField(record, "pattern");
      const path = stringField(record, "path");
      return {
        label: "搜索文本",
        target: [pattern && `“${pattern}”`, path].filter(Boolean).join(" · "),
      };
    }
    case "find": {
      const pattern = stringField(record, "pattern");
      const path = stringField(record, "path");
      return {
        label: "查找文件",
        target: [pattern, path].filter(Boolean).join(" · "),
      };
    }
    case "ls":
      return { label: "浏览目录", target: stringField(record, "path") || "当前目录" };
    case "list_roles":
      return { label: "查看角色", target: "可选 Agent 角色" };
    case "list_sessions":
      return {
        label: "查看会话",
        target: record?.scope === "created_by_me" ? "我创建的会话" : "项目会话",
      };
    case "current_session":
      return { label: "查看当前会话", target: "自身会话信息" };
    case "peek_session":
      return { label: "查看会话消息", ...conversationTarget() };
    case "start_session":
      return {
        label: "启动 Agent 会话",
        target: stringField(record, "title") || stringField(record, "roleId"),
      };
    case "send_session_message": {
      const conversationIds = Array.isArray(record?.conversationIds)
        ? record.conversationIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : [];
      return {
        label: "发送会话消息",
        ...(conversationIds.length > 0
          ? conversationTargets(conversationIds)
          : conversationTarget()),
      };
    }
    case "wait_for_session": {
      const targets = Array.isArray(record?.targets)
        ? record.targets.flatMap((target) => {
            const conversationId = stringField(asRecord(target), "conversationId");
            return conversationId ? [conversationId] : [];
          })
        : [];
      return {
        label: "等待 Agent 会话",
        ...conversationTargets(targets),
      };
    }
    case "abort_session":
      return { label: "终止 Agent 会话", ...conversationTarget() };
    case "delete_session":
      return { label: "删除 Agent 会话", ...conversationTarget() };
    default:
      return { label: name.replaceAll("_", " "), target: "" };
  }
}

function statusLabel(status: ToolItem["status"]): string {
  if (status === "pending") return "等待执行";
  if (status === "running") return "执行中";
  if (status === "done") return "已完成";
  return "执行失败";
}

type BashCardStatus = "in_progress" | "stopping" | "success" | "ended";

function bashCardStatus(tool: ToolItem): {
  status: BashCardStatus;
  label: string;
} | undefined {
  if (!new Set(["bash", "bash_poll", "bash_stop"]).has(tool.name)) {
    return;
  }
  const result = asRecord(tool.result);
  const piwebBash = asRecord(asRecord(result?.details)?.piwebBash);
  if (!piwebBash) return;

  if (Array.isArray(piwebBash.executions)) {
    const states = piwebBash.executions.flatMap((item) => {
      const state = asRecord(item)?.state;
      return state === "in_progress" || state === "stopping" ? [state] : [];
    });
    const running = states.filter((state) => state === "in_progress").length;
    const stopping = states.length - running;
    if (running + stopping === 0) return;
    return {
      status: stopping > 0 ? "stopping" : "in_progress",
      label: `本次查询时仍有 ${running} 个执行中，${stopping} 个停止中`,
    };
  }

  if (piwebBash.state === "in_progress") {
    return { status: "in_progress", label: "返回时命令仍在执行" };
  }
  if (piwebBash.state === "stopping") {
    return { status: "stopping", label: "已请求停止，尚未确认退出" };
  }
  if (piwebBash.state !== "finished") return;

  if (piwebBash.error !== undefined && piwebBash.error !== null) {
    return { status: "ended", label: "命令结束时伴随执行错误" };
  }
  if (piwebBash.exitCode === 0) {
    return { status: "success", label: "命令正常结束（退出码 0）" };
  }
  return {
    status: "ended",
    label: typeof piwebBash.exitCode === "number"
      ? `命令已结束（退出码 ${piwebBash.exitCode}）`
      : "命令已结束，退出码未确认",
  };
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replaceAll("_", " ");
}

function primitiveText(value: string | number | boolean | null, field?: string): string {
  if (value === null) return "无";
  if (typeof value === "boolean") {
    if (field === "ok") return value ? "成功" : "失败";
    return value ? "是" : "否";
  }
  if (field === "timeout" && typeof value === "number") {
    return value >= 1000 ? `${value / 1000} 秒` : `${value} 毫秒`;
  }
  if (field === "scope" && value === "created_by_me") return "我创建的会话";
  if (field === "scope" && value === "all") return "全部会话";
  if (typeof value === "string" && field?.endsWith("At")) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timestamp);
    }
  }
  if (typeof value === "string" && field) {
    return FIELD_VALUE_LABELS[field]?.[value] ?? value;
  }
  return String(value);
}

function ReadableValue({
  value,
  field,
}: {
  value: unknown;
  field?: string;
}): ReactNode {
  if (value === undefined) return <span className="tool-value">无</span>;
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    const text = primitiveText(value, field);
    return typeof value === "string" && value.includes("\n")
      ? <pre className="tool-text">{text}</pre>
      : <span className="tool-value">{text}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="tool-value">无</span>;
    return <ol className="tool-value-list">
      {value.map((item, index) => (
        <li key={index}><ReadableValue value={item} /></li>
      ))}
    </ol>;
  }

  const record = asRecord(value);
  if (!record) return <span className="tool-value">{String(value)}</span>;
  const entries = Object.entries(record).filter(([, item]) => item !== undefined);
  if (entries.length === 0) return <span className="tool-value">无</span>;
  return <dl className="tool-fields">
    {entries.map(([key, item]) => (
      <div className="tool-field" key={key}>
        <dt>{fieldLabel(key)}</dt>
        <dd><ReadableValue value={item} field={key} /></dd>
      </div>
    ))}
  </dl>;
}

function parsedJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function ToolResult({
  name,
  result,
  resultImageRefs,
  onOpenImage,
}: {
  name: string;
  result: unknown;
  resultImageRefs: ToolItem["resultImageRefs"];
  onOpenImage?: HistoricalImageOpenHandler;
}) {
  const record = asRecord(result);
  const details = record?.details;
  const content = Array.isArray(record?.content) ? record.content : undefined;
  const preferDetails = META_TOOL_NAMES.has(name) && details !== undefined;
  const refsByContentIndex = new Map(
    resultImageRefs?.map((reference) => [reference.contentIndex, reference]) ?? [],
  );
  const renderedRefIndexes = new Set<number>();
  const contentNodes = content?.flatMap((item, index): ReactNode[] => {
    const block = asRecord(item);
    if (
      block?.type === "text"
      && typeof block.text === "string"
      && !preferDetails
    ) {
      const structured = parsedJson(block.text);
      return [structured === undefined
        ? <pre className="tool-text" key={`text:${index}`}>
            {block.text || "无输出"}
          </pre>
        : <ReadableValue value={structured} key={`text:${index}`} />];
    }
    if (block?.type !== "image") return [];
    const reference = refsByContentIndex.get(index);
    if (reference !== undefined) renderedRefIndexes.add(index);
    return [reference !== undefined && onOpenImage !== undefined
      ? <HistoricalImageLink
          key={`image:${index}`}
          source={reference.source}
          onOpenImage={onOpenImage}
        />
      : <span className="tool-value" key={`image:${index}`}>
          {UNAVAILABLE_IMAGE_PLACEHOLDER}
        </span>];
  }) ?? [];
  const remainingImageNodes = (resultImageRefs ?? [])
    .filter((reference) => !renderedRefIndexes.has(reference.contentIndex))
    .map((reference) => onOpenImage !== undefined
      ? <HistoricalImageLink
          key={`image-ref:${reference.contentIndex}`}
          source={reference.source}
          onOpenImage={onOpenImage}
        />
      : <span className="tool-value" key={`image-ref:${reference.contentIndex}`}>
          {PROMPT_IMAGE_PLACEHOLDER}
        </span>);

  if (preferDetails && contentNodes.length === 0 && remainingImageNodes.length === 0) {
    return <ReadableValue value={details} />;
  }

  if (contentNodes.length > 0 || remainingImageNodes.length > 0) {
    return <>
      {contentNodes.length > 0
        ? contentNodes
        : <ReadableValue value={result} />}
      {remainingImageNodes}
      {details !== undefined && Object.keys(asRecord(details) ?? {}).length > 0
        ? <div className="tool-result-details">
            <h5>补充信息</h5>
            <ReadableValue value={details} />
          </div>
        : null}
    </>;
  }

  if (record && content) {
    if (details !== undefined) return <ReadableValue value={details} />;
    return <span className="tool-value">无输出</span>;
  }

  return <ReadableValue value={result} />;
}

export function ToolDetails({
  tool,
  onOpenImage,
}: {
  tool: ToolItem;
  onOpenImage?: HistoricalImageOpenHandler;
}) {
  return <div className="tool-body">
    {tool.args !== undefined
      ? <section className="tool-section">
          <h4>调用内容</h4>
          <ReadableValue value={tool.args} />
        </section>
      : null}
    {tool.result !== undefined
      ? <section className="tool-section">
          <h4>结果</h4>
          <ToolResult
            name={tool.name}
            result={tool.result}
            resultImageRefs={tool.resultImageRefs}
            onOpenImage={onOpenImage}
          />
        </section>
      : null}
  </div>;
}

export function ToolCard({
  tool,
  conversationTitleLookup,
  onOpenImage,
}: {
  tool: ToolItem;
  conversationTitleLookup?: ConversationTitleLookup;
  onOpenImage?: HistoricalImageOpenHandler;
}) {
  const presentation = toolPresentation(tool, conversationTitleLookup);
  const bashStatus = bashCardStatus(tool);
  const status = bashStatus?.label ?? statusLabel(tool.status);
  const isActive = tool.status === "pending" || tool.status === "running";
  const bashStatusClass = bashStatus === undefined
    ? ""
    : ` tool-bash-${bashStatus.status.replaceAll("_", "-")}`;
  const symbol = bashStatus?.status === "in_progress"
    ? "↗"
    : bashStatus?.status === "stopping"
      ? "…"
      : bashStatus?.status === "ended"
        ? "!"
        : "✓";

  return <details className={`tool tool-${tool.status}${bashStatusClass}`}>
    <summary>
      <span className="tool-status" aria-label={status}>
        {isActive
          ? <ActivitySpinner className="tool-spinner" />
          : <span className="tool-status-symbol" aria-hidden="true">
              {bashStatus === undefined ? (tool.status === "done" ? "✓" : "!") : symbol}
            </span>}
      </span>
      <span className="tool-summary">
        <strong>{presentation.label}</strong>
        {presentation.target
          ? <span
              className="tool-target"
              title={presentation.target}
            >
              {presentation.target}
            </span>
          : null}
        {bashStatus && <span className={`tool-bash-status-label ${bashStatusClass.trim()}`}>
          {bashStatus.label}
        </span>}
      </span>
      <span className="tool-chevron" aria-hidden="true">⌄</span>
    </summary>
    <ToolDetails tool={tool} onOpenImage={onOpenImage} />
  </details>;
}
