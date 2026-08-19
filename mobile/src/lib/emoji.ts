// Ordered [pattern, emoji] pairs — text typed in the message input is scanned
// for these exact substrings and swapped live, the way Slack/Discord do it.
export const EMOJI_SHORTCUTS: [string, string][] = [
  [":-)", "🙂"],
  [":)", "🙂"],
  [":-(", "🙁"],
  [":(", "🙁"],
  [":-D", "😃"],
  [":D", "😃"],
  [";-)", "😉"],
  [";)", "😉"],
  [":-P", "😛"],
  [":P", "😛"],
  [":-p", "😛"],
  [":p", "😛"],
  ["xD", "😆"],
  ["XD", "😆"],
  ["<3", "❤️"],
  ["</3", "💔"],
  [":-O", "😮"],
  [":O", "😮"],
  [":-o", "😮"],
  [":o", "😮"],
  [":'(", "😢"],
  [":|", "😐"],
  ["B)", "😎"],
  [":fire:", "🔥"],
  [":heart:", "❤️"],
  [":thumbsup:", "👍"],
  [":+1:", "👍"],
  [":thumbsdown:", "👎"],
  [":-1:", "👎"],
  [":laughing:", "😆"],
  [":joy:", "😂"],
  [":cry:", "😢"],
  [":smile:", "😄"],
  [":grin:", "😁"],
  [":wink:", "😉"],
  [":clap:", "👏"],
  [":100:", "💯"],
  [":tada:", "🎉"],
  [":rocket:", "🚀"],
  [":eyes:", "👀"],
  [":pray:", "🙏"],
  [":check:", "✅"],
  [":x:", "❌"],
  [":star:", "⭐"],
  [":sob:", "😭"],
  [":skull:", "💀"],
  [":poop:", "💩"],
];

export function applyEmojiShortcuts(text: string): string {
  let result = text;
  for (const [pattern, emoji] of EMOJI_SHORTCUTS) {
    if (result.includes(pattern)) {
      result = result.split(pattern).join(emoji);
    }
  }
  return result;
}

export const EMOJI_PICKER_LIST = [
  "😀", "😁", "😂", "🤣", "😊", "😉", "😍", "😘", "😜", "🤔",
  "😎", "🥳", "😢", "😭", "😡", "😱", "🥺", "😴", "🤗", "🙄",
  "👍", "👎", "👏", "🙏", "💪", "🤝", "👋", "✌️", "🤞", "🙌",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💯",
  "🔥", "✨", "🎉", "🎂", "🎁", "⭐", "☀️", "🌈", "⚡", "💧",
  "🍕", "🍔", "🍟", "🍩", "☕", "🍺", "🍷", "🍎", "🍓", "🥑",
  "🐶", "🐱", "🐼", "🦄", "🐸", "🦋", "🌸", "🌻", "🍀", "🌙",
];
