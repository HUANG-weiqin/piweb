import type { ConversationImageLocator } from "../../shared/protocol";
import { PROMPT_IMAGE_PLACEHOLDER } from "../../shared/protocol";

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
    {PROMPT_IMAGE_PLACEHOLDER}
  </button>;
}
