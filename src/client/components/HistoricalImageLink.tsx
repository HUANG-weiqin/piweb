import type { ConversationImageLocator } from "../../shared/protocol";

export type HistoricalImageOpenHandler = (
  source: ConversationImageLocator,
) => void;

export function HistoricalImageLink({
  source,
  onOpenImage,
}: {
  source: ConversationImageLocator;
  onOpenImage: HistoricalImageOpenHandler;
}) {
  return <button
    type="button"
    className="message-image-link"
    aria-label={`在新标签页中打开图片 ${source.imageOrdinal + 1}`}
    title="在新标签页中打开图片"
    onClick={() => onOpenImage(source)}
  >
    {`查看图片 ${String(source.imageOrdinal + 1).padStart(2, "0")} ↗`}
  </button>;
}
