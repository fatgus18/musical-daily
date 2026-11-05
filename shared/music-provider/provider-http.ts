/** Stop chunked responses at the byte boundary instead of allocating the whole body first. */
export async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maximumBytes) { await response.body?.cancel(); throw new Error("Provider response is too large."); }
  if (!response.body) return "";
  const reader = response.body.getReader(); const decoder = new TextDecoder(); const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) { await reader.cancel(); throw new Error("Provider response is too large."); }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode()); return parts.join("");
  } finally { reader.releaseLock(); }
}
