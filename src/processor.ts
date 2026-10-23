export const MAX_INPUT_LENGTH = 4096;

export function removeCommas(text: string): string {
  const coordinate = /^(\s*[+-]?\d+),(\d+)(?:\s*,\s*|\s+)([+-]?\d+),(\d+)(\s*)$/.exec(text);

  if (coordinate) {
    const latitude = Number(`${coordinate[1].trim()}.${coordinate[2]}`);
    const longitude = Number(`${coordinate[3]}.${coordinate[4]}`);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return `${coordinate[1]}.${coordinate[2]} ${coordinate[3]}.${coordinate[4]}${coordinate[5]}`;
    }
  }

  return text.replaceAll(",", "");
}
