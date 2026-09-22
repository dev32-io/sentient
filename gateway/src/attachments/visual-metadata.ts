/** Normalized coordinates in the upright source image/frame, not the displayed thumbnail. */
export interface AttachmentImageRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Known facts only: absent fields mean unavailable, not zero or false. */
export interface AttachmentSourceMetadata {
  readonly kind: "image" | "animation" | "multi_page_image" | "live_photo" | "pdf";
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly originalAvailable: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly storedWidth?: number;
  readonly storedHeight?: number;
  readonly orientation?: number;
  readonly pageCount?: number;
  readonly frameCount?: number;
  readonly durationMs?: number;
  readonly hasAlpha?: boolean;
  readonly motionAvailable?: boolean;
}

/** Describes the pixels actually supplied, including any selection or downsampling. */
export interface AttachmentViewMetadata {
  readonly kind: "overview" | "crop" | "frame" | "page";
  readonly width: number;
  readonly height: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly region?: AttachmentImageRegion;
  /** Zero-based frame index, when known. */
  readonly frameIndex?: number;
  readonly timeMs?: number;
  readonly page?: number;
  readonly downsampled?: boolean;
  readonly partialCoverage?: boolean;
}
