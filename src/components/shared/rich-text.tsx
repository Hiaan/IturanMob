import { Fragment } from "react";

/**
 * Renderização segura de texto com marcações leves (*negrito*, **negrito**, _itálico_, listas),
 * sem HTML arbitrário — o conteúdo vem do assistente/IA e é tratado como texto.
 */
function inline(text: string, keyBase: string) {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) parts.push(<strong key={`${keyBase}-${i++}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("*")) parts.push(<strong key={`${keyBase}-${i++}`}>{token.slice(1, -1)}</strong>);
    else parts.push(<em key={`${keyBase}-${i++}`} className="text-muted-foreground">{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n");
  return (
    <div className={className}>
      {lines.map((line, idx) => {
        const bullet = /^\s*(?:[-•]|\d+\.)\s+/.exec(line);
        if (bullet) {
          return (
            <div key={idx} className="flex gap-2 pl-1">
              <span className="text-muted-foreground">{bullet[0].trim().replace("-", "•")}</span>
              <span>{inline(line.slice(bullet[0].length), `l${idx}`)}</span>
            </div>
          );
        }
        if (!line.trim()) return <div key={idx} className="h-2" />;
        if (/^#{1,3}\s/.test(line)) return <p key={idx} className="font-semibold">{inline(line.replace(/^#{1,3}\s/, ""), `h${idx}`)}</p>;
        return <Fragment key={idx}><p>{inline(line, `p${idx}`)}</p></Fragment>;
      })}
    </div>
  );
}
