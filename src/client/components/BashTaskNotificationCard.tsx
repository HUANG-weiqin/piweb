import type { ConversationBashTaskNotification } from "../../shared/protocol";

export interface BashTaskNotificationCardProps {
  notification: ConversationBashTaskNotification;
}

function statusLabel(status: ConversationBashTaskNotification["tasks"][number]["status"]): string {
  if (status === "completed") return "完成";
  if (status === "killed") return "已停止";
  return "失败";
}

export function BashTaskNotificationCard({
  notification,
}: BashTaskNotificationCardProps) {
  return <article
    className="bash-task-notification-card"
    aria-label={`后台 Bash 任务通知，共 ${notification.tasks.length} 项`}
  >
    <header className="bash-task-notification-header">
      <strong>BACKGROUND BASH</strong>
      <time dateTime={notification.timestamp}>{new Date(notification.timestamp)
        .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </header>
    <ul className="bash-task-notification-list">
      {notification.tasks.map((task) => <li
        className={`bash-task-notification-task is-${task.status}`}
        key={task.taskId}
      >
        <div className="bash-task-notification-task-heading">
          <strong>{statusLabel(task.status)}</strong>
          <code>{task.command}</code>
        </div>
        <div className="bash-task-notification-task-facts">
          <span>退出码 {task.exitCode ?? "未知"}</span>
          <span>{Math.round(task.durationMs)} ms</span>
          {task.partial && <span>输出不完整</span>}
          {task.stopReason && <span>停止原因 {task.stopReason}</span>}
        </div>
        {task.outputFile && <div className="bash-task-notification-output-file">
          完整输出：<code>{task.outputFile}</code>
        </div>}
      </li>)}
    </ul>
    <pre className="bash-task-notification-text">{notification.text}</pre>
  </article>;
}
