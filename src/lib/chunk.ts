// 按字符数切分，带重叠，避免语义在切分边界丢失
export function chunkText(text: string, size = 800, overlap = 150): string[] {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + size, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = end - overlap;
  }
  return chunks.filter((c) => c.trim().length > 20); // 过滤掉太短的碎片
}