export const MAX_INPUT_LENGTH = 4096;

export function removeCommas(text: string): string {
  return text.replaceAll(",", "");
}
