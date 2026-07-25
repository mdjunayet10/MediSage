import { Check, ChevronDown, Copy, Database, FileText } from "lucide-react";
import { useEffect, useState } from "react";

function SourceCard({ source, active, messageId }) {
  const [copied, setCopied] = useState(false);
  async function copyExcerpt() {
    try {
      await navigator.clipboard.writeText(source.excerpt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article
      id={`source-${messageId}-${source.id}`}
      className={`source-card ${active ? "source-card-active" : ""}`}
    >
      <span className="source-accent" />
      <div className="source-icon">
        {source.type === "document" ? (
          <FileText size={15} />
        ) : (
          <Database size={15} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {source.url ? (
            <a
              className="truncate text-[13px] font-semibold text-main"
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              {source.title}
            </a>
          ) : (
            <p className="truncate text-[13px] font-semibold text-main">
              {source.title}
            </p>
          )}
          <span className="source-id">{source.id}</span>
          <span className="page-chip">
            {source.type === "document"
              ? source.page
                ? `Page ${source.page}`
                : source.location?.sheet
                  ? `${source.location.sheet} · rows ${source.location.rowStart}–${source.location.rowEnd}`
                  : source.location?.rowStart
                    ? `Rows ${source.location.rowStart}–${source.location.rowEnd}`
                    : source.location?.section || "Attachment"
              : `Record ${source.recordId}`}
          </span>
        </div>
        <p className="source-excerpt">{source.excerpt}</p>
        <div className="mt-2 flex justify-end gap-1">
          {source.url && (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="micro-action"
            >
              View dataset
            </a>
          )}
          <button
            type="button"
            onClick={copyExcerpt}
            className="micro-action"
            aria-label={`Copy excerpt from ${source.title}`}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy excerpt"}
          </button>
        </div>
      </div>
    </article>
  );
}

export default function SourcesPanel({
  sources = [],
  groundingType = "general",
  activeSource,
  messageId,
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (
      activeSource &&
      sources.findIndex((source) => source.id === activeSource) >= 2
    )
      setExpanded(true);
  }, [activeSource, sources]);

  if (!sources.length)
    return groundingType === "general" ? (
      <p className="ungrounded-note">General educational response</p>
    ) : null;
  const visible = expanded ? sources : sources.slice(0, 2);
  return (
    <section className="sources-panel" aria-label="Answer sources">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="sources-heading"
        aria-expanded={expanded}
      >
        <span>
          Sources <span className="source-count">{sources.length}</span>
        </span>
        {sources.length > 2 && (
          <ChevronDown size={15} className={expanded ? "rotate-180" : ""} />
        )}
      </button>
      <div className={`source-list ${expanded ? "source-list-expanded" : ""}`}>
        {visible.map((source) => (
          <SourceCard
            key={`${source.id}-${source.stableId || ""}`}
            source={source}
            active={activeSource === source.id}
            messageId={messageId}
          />
        ))}
      </div>
      {!expanded && sources.length > 2 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="show-more-source"
        >
          Show {sources.length - 2} more
        </button>
      )}
      {sources.some((source) => source.type === "dataset") && (
        <p className="dataset-source-note">
          Dataset material is provided for educational support and may require
          professional verification.
        </p>
      )}
    </section>
  );
}
