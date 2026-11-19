// Stand-in for Core's zylos-memory measureMemoryText with small, fixed limits.
// Same result shape as Core; real-Core compatibility is covered by integration tests.
const limit = { maxChars: 1000, maxTokens: 250 };
const warnThreshold = { chars: limit.maxChars * 0.8, estimatedTokens: limit.maxTokens * 0.8 };
function estimateTokens(text) {
  let ascii = 0, other = 0;
  for (const char of text) { if (char.codePointAt(0) < 128) ascii++; else other++; }
  return Math.ceil(ascii / 4 + other / 1.3);
}
export function measureMemoryText(file, text) {
  if (file !== 'identity.md') throw new Error(`No memory budget for ${file}`);
  const chars = text.length, estimatedTokens = estimateTokens(text);
  const over = chars > limit.maxChars || estimatedTokens > limit.maxTokens;
  const warning = chars >= warnThreshold.chars || estimatedTokens >= warnThreshold.estimatedTokens;
  return { chars, estimatedTokens, sizeBytes: Buffer.byteLength(text), ...limit, warnThreshold, status: over ? 'over' : warning ? 'warning' : 'ok' };
}
