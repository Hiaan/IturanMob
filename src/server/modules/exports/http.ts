/** Resposta binária para download (as rotas retornam a Response diretamente). */
export function fileResponse(content: Buffer | Uint8Array, contentType: string, fileName: string, opts: { inline?: boolean } = {}): Response {
  const asciiName = fileName.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "_") || "arquivo";
  const body = Uint8Array.from(content);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `${opts.inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
