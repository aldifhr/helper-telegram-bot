export const MAX_INPUT_LENGTH = 4096;

export interface CoordinatePair {
  latitude: string;
  longitude: string;
}

export function parseCoordinatePair(text: string): CoordinatePair | undefined {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) {
    return undefined;
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return undefined;
  }

  return { latitude: match[1], longitude: match[2] };
}

export function removeCommas(text: string): string {
  const fullPair = normalizeCommaDecimalPair(text);
  if (fullPair !== undefined) {
    return fullPair;
  }

  const labeledPair = /((?:coordinate|coordinates|koordinat(?:nya)?|lokasi)\s*[:=]\s*)([+-]?\d+),(\d+)\s*,\s*([+-]?\d+),(\d+)(?![\d.,])/i.exec(text);
  if (labeledPair) {
    const pair = `${labeledPair[2]},${labeledPair[3]},${labeledPair[4]},${labeledPair[5]}`;
    const normalizedPair = normalizeCommaDecimalPair(pair);
    if (normalizedPair !== undefined) {
      return text.replace(labeledPair[0], `${labeledPair[1]}${normalizedPair}`);
    }
  }

  return text.replaceAll(",", "");
}

function normalizeCommaDecimalPair(text: string): string | undefined {
  const match = /^(\s*)([+-]?\d+),(\d+)(?:\s*,\s*|\s+)([+-]?\d+),(\d+)(\s*)$/.exec(text);
  if (!match) {
    return undefined;
  }

  const latitude = Number(`${match[2]}.${match[3]}`);
  const longitude = Number(`${match[4]}.${match[5]}`);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return undefined;
  }

  return `${match[1]}${match[2]}.${match[3]} ${match[4]}.${match[5]}${match[6]}`;
}
