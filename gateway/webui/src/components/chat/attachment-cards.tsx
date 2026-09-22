import type { JSX } from "preact";
import type { ChatAttachment } from "../../types.ts";
import { Dialog } from "../common/dialog.tsx";

export interface AttachmentAsset {
  readonly previewUrl?: string;
  readonly downloadUrl?: string;
  readonly onDownload?: () => void;
  readonly error?: boolean;
}

export interface AttachmentMetadata {
  readonly displayName: string;
  readonly contentType: string;
  readonly mediaKind: "image" | "pdf" | "text";
  readonly size: number;
}

export function attachmentKey(attachment: ChatAttachment): string {
  return attachment.kind === "remote" ? attachment.ref.attachmentId : attachment.id;
}

export function attachmentMetadata(attachment: ChatAttachment): AttachmentMetadata {
  if (attachment.kind === "remote") return attachment.ref;
  return {
    displayName: attachment.name,
    contentType: attachment.type,
    mediaKind: attachment.type.startsWith("image/") || attachment.type === "application/vnd.sentient.live-photo+zip"
      ? "image"
      : attachment.type === "application/pdf" ? "pdf" : "text",
    size: attachment.blob.size,
  };
}

function sizeLabel(size: number): string {
  return `${Math.max(1, Math.ceil(size / 1024))} KB`;
}

function DownloadIcon(): JSX.Element {
  return (
    <svg class="message-attachment__download-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14" />
    </svg>
  );
}

function DownloadControl({ metadata, asset }: { metadata: AttachmentMetadata; asset?: AttachmentAsset | undefined }): JSX.Element | null {
  const label = `Download ${metadata.displayName}`;
  if (asset?.downloadUrl) {
    return (
      <a
        href={asset.downloadUrl}
        download={metadata.displayName}
        class="message-attachment__download"
        aria-label={label}
        title={label}
      >
        <DownloadIcon />
      </a>
    );
  }
  if (asset?.onDownload) {
    return (
      <button type="button" class="message-attachment__download" onClick={asset.onDownload} aria-label={label} title={label}>
        <DownloadIcon />
      </button>
    );
  }
  return null;
}

function AttachmentContent({ metadata, asset }: { metadata: AttachmentMetadata; asset?: AttachmentAsset | undefined }): JSX.Element {
  return (
    <>
      {(metadata.mediaKind === "image" || metadata.mediaKind === "pdf") && asset?.previewUrl && (
        <img class="message-attachment__image" src={asset.previewUrl} alt={`${metadata.displayName} preview`} />
      )}
      <span class="message-attachment__details">
        <span class="message-attachment__name" title={metadata.displayName}>{metadata.displayName}</span>
        <span class="message-attachment__meta">{metadata.mediaKind.toUpperCase()} · {sizeLabel(metadata.size)}</span>
      </span>
    </>
  );
}

function PreviewTrigger({
  attachment,
  metadata,
  asset,
  onPreview,
}: {
  attachment: ChatAttachment;
  metadata: AttachmentMetadata;
  asset?: AttachmentAsset | undefined;
  onPreview?: ((attachment: ChatAttachment) => void) | undefined;
}): JSX.Element {
  const content = <AttachmentContent metadata={metadata} asset={asset} />;
  if (!onPreview) return <div class="message-attachment__preview-trigger">{content}</div>;
  return (
    <button
      type="button"
      class="message-attachment__preview-trigger"
      aria-label={`Preview ${metadata.displayName}`}
      onClick={() => onPreview(attachment)}
    >
      {content}
    </button>
  );
}

export function AttachmentCards({
  attachments,
  assets,
  onPreview,
}: {
  attachments: readonly ChatAttachment[];
  assets: Readonly<Record<string, AttachmentAsset>>;
  onPreview?: ((attachment: ChatAttachment) => void) | undefined;
}): JSX.Element {
  return (
    <ul class="message-attachments" aria-label="Attachments">
      {attachments.map((attachment) => {
        const key = attachmentKey(attachment);
        const metadata = attachmentMetadata(attachment);
        const asset = assets[key];
        const hasActions = attachment.kind === "local" && (
          attachment.status === "uploading"
            ? Boolean(attachment.onCancel)
            : (attachment.status === "failed" || attachment.status === "cancelled") && Boolean(attachment.onRetry || attachment.onEdit || attachment.onRemove)
        );
        return (
          <li class="message-attachment" key={key}>
            <PreviewTrigger attachment={attachment} metadata={metadata} asset={asset} onPreview={onPreview} />
            {attachment.kind === "local" && (
              <span class="message-attachment__status" role="status">
                {attachment.status === "uploading" ? `Uploading ${Math.round((attachment.progress ?? 0) * 100)}%` : attachment.statusMessage ?? attachment.status}
              </span>
            )}
            {asset?.error && <span class="message-attachment__status" role="status">File unavailable</span>}
            {hasActions && (
              <div class="message-attachment__actions">
                {attachment.kind === "local" && attachment.status === "uploading" && attachment.onCancel && (
                  <button type="button" onClick={attachment.onCancel}>Cancel</button>
                )}
                {attachment.kind === "local" && (attachment.status === "failed" || attachment.status === "cancelled") && attachment.onRetry && (
                  <button type="button" onClick={attachment.onRetry}>Retry</button>
                )}
                {attachment.kind === "local" && (attachment.status === "failed" || attachment.status === "cancelled") && attachment.onEdit && (
                  <button type="button" onClick={attachment.onEdit}>Edit message</button>
                )}
                {attachment.kind === "local" && (attachment.status === "failed" || attachment.status === "cancelled") && attachment.onRemove && (
                  <button type="button" onClick={attachment.onRemove}>Remove</button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AttachmentPreviewDialog({
  attachment,
  asset,
  onClose,
}: {
  attachment: ChatAttachment;
  asset?: AttachmentAsset | undefined;
  onClose(): void;
}): JSX.Element {
  const metadata = attachmentMetadata(attachment);
  return (
    <Dialog title={metadata.displayName} onClose={onClose} width={720}>
      <div class="message-attachment-preview">
        {asset?.previewUrl ? (
          <img class="message-attachment-preview__image" src={asset.previewUrl} alt={`${metadata.displayName} preview`} />
        ) : (
          <div class="message-attachment-preview__fallback" role="status">
            Preview unavailable. File details remain available.
          </div>
        )}
        <dl class="message-attachment-preview__details">
          <div><dt>Type</dt><dd>{metadata.contentType}</dd></div>
          <div><dt>Size</dt><dd>{sizeLabel(metadata.size)}</dd></div>
        </dl>
        {asset?.error && <p class="message-attachment-preview__error" role="status">File unavailable</p>}
        <div class="message-attachment-preview__actions">
          <DownloadControl metadata={metadata} asset={asset} />
        </div>
      </div>
    </Dialog>
  );
}
