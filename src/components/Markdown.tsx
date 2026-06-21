import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

interface ShikiHighlighter {
  codeToHtml(code: string, options: { lang: string; theme: string }): string;
}

let shikiPromise: Promise<ShikiHighlighter> | null = null;

/** Lazily build a Shiki highlighter once on first code-block render.
 *  Preloads the four languages real chat traffic uses (ts, python,
 *  rust, bash); other languages still render as `pre code` without
 *  highlighting via the fallback in the code component below. */
function getHighlighter(): Promise<ShikiHighlighter> {
  if (!shikiPromise) {
    shikiPromise = import("shiki").then((s) =>
      s.createHighlighter({
        themes: ["github-dark-default", "github-light"],
        langs: ["ts", "tsx", "js", "jsx", "python", "rust", "bash", "json", "yaml", "go", "java", "cpp", "c", "html", "css", "sql", "markdown"],
      }),
    );
  }
  return shikiPromise;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hl = await getHighlighter();
        const rendered = hl.codeToHtml(code, {
          lang,
          theme: isDark ? "github-dark-default" : "github-light",
        });
        if (!cancelled) setHtml(rendered);
      } catch {
        if (!cancelled) setHtml(null); // fall back to plain pre
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lang, code, isDark]);

  return html ? (
    <div
      className="shiki-block overflow-x-auto rounded-none border border-border text-xs"
      // shiki renders trusted-by-construction HTML from our own input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <pre className="overflow-x-auto border border-border bg-secondary p-3 text-xs">
      <code>{code}</code>
    </pre>
  );
}

interface MarkdownProps {
  children: string;
  /** When the parent message is still streaming, skip shiki on the
   *  last (still-open) code fence. Re-tokenising an incomplete fence
   *  on every flush is one of the documented amplifiers of the
   *  whole-screen flicker on M-series GPUs; finished fences earlier
   *  in the message keep their highlighting. */
  streaming?: boolean;
}

/** Heuristic: does the markdown string end inside an unclosed ```
 *  code fence? Counts the fence markers; an odd total means the
 *  trailing fence is still open. */
function endsInOpenCodeFence(md: string): boolean {
  const fences = md.match(/^```/gm);
  return !!fences && fences.length % 2 === 1;
}

/** Streaming-safe markdown renderer.
 *
 *  - `remark-gfm` for tables, task lists, autolinks, strikethrough.
 *  - `rehype-sanitize` clamps the HTML to a safe subset (no raw
 *    script/style, no on* handlers) so a malicious model can't
 *    inject anything.
 *  - Code blocks lazy-load shiki and apply the dark/light github
 *    theme matching the system colour scheme. The inline `code`
 *    variant uses the bg-secondary token from the OKLCH palette.
 *  - When `streaming` is true and the trailing fence is still open,
 *    the partial fence renders as plain `<pre>` until it closes —
 *    avoids re-tokenising a growing string on every flush.
 */
export const Markdown = memo(function Markdown({ children, streaming }: MarkdownProps) {
  const skipTrailingShiki = !!streaming && endsInOpenCodeFence(children);
  // Count fenced code blocks during render so we can identify the
  // trailing one in the `code` component callback. Reset on every
  // render because react-markdown walks the AST in order.
  let codeBlockIdx = 0;
  const totalCodeBlocks = (children.match(/^```/gm)?.length ?? 0) >> 1;
  return (
    <div className="prose prose-sm max-w-none text-foreground dark:prose-invert prose-pre:my-2 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const langMatch = /language-([\w+-]+)/.exec(className ?? "");
            const code = String(children).replace(/\n$/, "");
            if (inline || !langMatch) {
              return (
                <code
                  className="rounded-sm border border-border bg-secondary px-1 py-0.5 text-xs"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            const isTrailing = codeBlockIdx === totalCodeBlocks;
            codeBlockIdx += 1;
            if (skipTrailingShiki && isTrailing) {
              return (
                <pre className="overflow-x-auto border border-border bg-secondary p-3 text-xs">
                  <code>{code}</code>
                </pre>
              );
            }
            return <CodeBlock lang={langMatch[1]} code={code} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
