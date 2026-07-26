/**
 * Message Projection per docs/requirements.md 2.3: text/at/reply and known
 * faces become text directly; media keeps structured data and enters the
 * projection as a descriptive placeholder. No OCR/ASR in v1.
 */
import type { OneBotSegment } from "../bridge/onebot-events.ts";

const PLACEHOLDERS: Record<string, string> = {
  image: "[图片]",
  record: "[语音]",
  video: "[视频]",
  file: "[文件]",
  json: "[卡片]",
  xml: "[卡片]",
  forward: "[聊天记录]",
  face: "[表情]",
  reply: "[回复]",
  dice: "[骰子]",
  rps: "[猜拳]",
  shake: "[窗口抖动]",
  poke: "[戳一戳]",
  music: "[音乐分享]",
  share: "[链接分享]",
  location: "[位置]",
};

function projectSegment(segment: OneBotSegment): string {
  switch (segment.type) {
    case "text": {
      const text = segment.data["text"];
      return typeof text === "string" ? text : "";
    }
    case "at": {
      const qq = segment.data["qq"];
      if (qq === "all") return "@全体成员";
      const name = segment.data["name"];
      const label = typeof name === "string" && name !== "" ? name : String(qq ?? "");
      return `@${label}`;
    }
    case "face": {
      // Face names are textualized when the bridge provides one; bare ids stay placeholders.
      const raw = segment.data["raw"];
      const rawText =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)["faceText"]
          : undefined;
      const name = [segment.data["name"], segment.data["faceText"], rawText].find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      if (name === undefined) return "[表情]";
      const trimmed = name.trim();
      return trimmed.startsWith("[") ? trimmed : `[${trimmed}]`;
    }
    default:
      return PLACEHOLDERS[segment.type] ?? `[${segment.type}]`;
  }
}

function isUsableSegment(segment: unknown): segment is OneBotSegment {
  // typeof null === "object": explicit null checks keep one malformed segment
  // from throwing away the whole message.
  return (
    typeof segment === "object" &&
    segment !== null &&
    typeof (segment as OneBotSegment).type === "string" &&
    typeof (segment as OneBotSegment).data === "object" &&
    (segment as OneBotSegment).data !== null
  );
}

export function projectSegments(segments: readonly unknown[]): string {
  return segments.filter(isUsableSegment).map(projectSegment).join("");
}
