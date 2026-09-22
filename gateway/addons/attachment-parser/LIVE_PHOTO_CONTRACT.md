# Live Photo attachment bundle v1

Native importers upload one logical image attachment with media type
`application/vnd.sentient.live-photo+zip`. Payload is a ZIP containing exactly:

```text
live-photo/manifest.json
live-photo/still.<canonical extension>
live-photo/motion.mov
```

A `live-photo/` directory entry is optional. No other entries are allowed. Names are fixed relative paths: never include user filenames, source paths, or metadata-derived names.

Manifest is UTF-8 JSON:

```json
{
  "version": 1,
  "still": {
    "name": "live-photo/still.jpg",
    "mediaType": "image/jpeg"
  },
  "motion": {
    "name": "live-photo/motion.mov",
    "mediaType": "video/quicktime"
  }
}
```

Still extension must be parser canonical extension for declared supported image MIME (`jpg`, `png`, `heic`, `heif`, `avif`, `webp`, `gif`, `tiff`, `bmp`, `jp2`, or `jxl`). Motion must be QuickTime MOV. Ordinary video uploads remain unsupported.

Parser rejects encrypted entries, symlinks, duplicate/absolute/traversing paths, more than four entries, manifests over 64 KiB, expanded totals over configured cap, malformed media, or missing pair members. Originals remain stored unchanged; extraction uses fixed transient paths only.
