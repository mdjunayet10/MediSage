import { FileText, RefreshCw, X } from "lucide-react";

function detail(attachment) {
  if (attachment.status === "uploading") {
    return attachment.uploadProgress == null
      ? "Uploading…"
      : `Uploading · ${attachment.uploadProgress}%`;
  }
  if (attachment.status === "processing") {
    const stage = attachment.localOnly
      ? "Extracting locally…"
      : "Preparing document…";
    return attachment.progress && attachment.progress < 100
      ? `${stage} · ${attachment.progress}%`
      : stage;
  }
  if (attachment.status === "failed") return "Processing failed";
  if (attachment.status === "expired") return "Attachment expired";
  if (attachment.pageCount) return `${String(attachment.type || attachment.kind || "PDF").toUpperCase()} · ${attachment.pageCount} pages`;
  if (attachment.sheetCount) return `${String(attachment.type || attachment.kind || "XLSX").toUpperCase()} · ${attachment.sheetCount} sheets`;
  return `${String(attachment.type || attachment.kind || attachment.extension || "File").toUpperCase()} · ready`;
}

export default function AttachmentCard({
  attachment,
  mode = "draft",
  onRemove,
  onRetry,
  onToggleScope,
  onDetails,
}) {
  return (
    <div className={`attachment-card attachment-card-${mode}`} data-attachment-id={attachment.id || attachment.localId}>
      <div className="attachment-card-icon"><FileText size={17} /></div>
      <button type="button" className="attachment-card-main" onClick={() => onDetails?.(attachment)} disabled={!onDetails}>
        <strong>{attachment.name || attachment.filename}</strong>
        <span>{detail(attachment)}</span>
      </button>
      {mode === "draft" && onToggleScope && (
        <button type="button" className="attachment-scope" onClick={() => onToggleScope(attachment)}>
          {attachment.scope === "message" ? "This message" : "Use in chat"}
        </button>
      )}
      {attachment.status === "failed" && onRetry && (
        <button type="button" className="attachment-icon-action" onClick={() => onRetry(attachment)} aria-label={`Retry ${attachment.name || attachment.filename}`}><RefreshCw size={14} /></button>
      )}
      {onRemove && (
        <button type="button" className="attachment-icon-action" onClick={() => onRemove(attachment)} aria-label={`Remove ${attachment.name || attachment.filename}`}><X size={15} /></button>
      )}
      {["uploading", "processing"].includes(attachment.status) &&
        (attachment.uploadProgress != null || attachment.progress != null) && (
        <span
          className="attachment-progress"
          style={{
            width: `${attachment.uploadProgress ?? attachment.progress}%`,
          }}
        />
      )}
    </div>
  );
}
