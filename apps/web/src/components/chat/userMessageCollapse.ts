// The character threshold is a first-paint overflow hint; rendered message
// height is governed by the line limit.
export const COLLAPSED_USER_MESSAGE_MAX_CHARS = 600;
export const USER_MESSAGE_COLLAPSED_MAX_LINES = 12;
export const USER_MESSAGE_COLLAPSED_FADE_LINES = 2;

export function userMessageLikelyOverflows(text: string): boolean {
  if (text.length > COLLAPSED_USER_MESSAGE_MAX_CHARS) {
    return true;
  }

  let newlineCount = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlineCount += 1;
    if (newlineCount >= USER_MESSAGE_COLLAPSED_MAX_LINES) {
      return true;
    }
  }
  return false;
}
