/**
 * Fish Audio voice catalog metadata.
 *
 * Used by the Fish-browse-and-clone module (self-contained, removable —
 * see gateway/src/providers/fish/). Field names are camelCase per project
 * TS rules.
 */

export interface VoiceEntry {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
  coverImageUrl: string | null;
  previewAudioUrl: string | null;
  visibility: "public" | "private";
  taskCount: number;
  createdAt: string;
}
