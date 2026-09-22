# Attachment parser addon

Attachment-only Poppler/libvips/FFmpeg service. Container stays at Docker `network_mode: none`. Server and exec client communicate only through `/tmp/attachment-parser/parser.sock` on bounded container tmpfs; no host mount or TCP listener.

One heavy decoder job runs at a time, with one CPU, 1.25 GiB tmpfs and 2 GiB memory. Source and aggregate Live Photo extraction caps are each 512 MiB, leaving workspace for bounded output and bookkeeping. Raster images are limited to 225 MP; Live Photo movie frames have a separate 16 MP pre-decode gate. Decoder steps have a 20-second deadline and the gateway adapter a 30-second deadline. These are safety ceilings, not a guarantee that every codec variant succeeds at the limits. Per-user original storage quota remains 2 GiB.

## Identity and Docker exec protocol

`addon.json` is authoritative metadata for this image:

```json
{"name":"attachment-parser","version":"0.2.0","protocolVersion":2,"description":"…","state":"ephemeral"}
```

Protocol version 2 covers this metadata plus visual selector contract. It is
separate from binary response `version: 1` frames. The same manifest feeds
`GET /health` and the bounded metadata command:

```text
python3 /app/exec_client.py metadata REQUEST_UUID
python3 /app/exec_client.py --health [--deadline-ms N]
```

`metadata` only reads the bundled manifest and returns one binary `version: 1`
frame whose JSON body is that manifest. `--health` performs a bounded UDS
`GET /health`, verifies live server metadata exactly matches the manifest, and
prints plain manifest JSON. It returns nonzero with a sanitized diagnostic when
server is unavailable, times out, or reports wrong metadata. Neither command
accepts input bytes.

Start requests with an argv array—never a shell command:

```text
python3 /app/exec_client.py request REQUEST_UUID OPERATION MEDIA_TYPE CONTENT_LENGTH [OPTIONS]
```

Operations and allowed options:

- `pdf-header`
- `pdf-text [--first-page N] [--last-page N]`
- `pdf-render --page N [--max-edge N]`
- `image-header`
- `image-normalize [--max-edge N] [--region-x X --region-y Y --region-width W --region-height H] [--frame-index N | --time-ms N]`
- every request may set `--deadline-ms N` (`1..35000`)

Supported image media types: JPEG, PNG, HEIC, HEIF, AVIF, WebP, GIF, TIFF, BMP, JPEG 2000 (`image/jp2`), JPEG XL (`image/jxl`), plus the [Live Photo bundle](LIVE_PHOTO_CONTRACT.md). `application/pdf` retains existing page/text behavior. Stream exactly `CONTENT_LENGTH` raw bytes to stdin, then close stdin. Client rejects invalid UUIDs, operation/media mismatches, unexpected options, out-of-range numbers, short input, extra input, and input over configured limit.

Classic TIFF and BigTIFF, in either byte order, receive a seek-based metadata walk before storage and decode. Walk follows next-IFD and SubIFD links with aggregate limits of 256 IFDs, 8,192 entries, and 1 MiB read. Known DNG/CR2/CFA, standard CFA/linear-RAW photometric values, and Nikon RAW compression are rejected. Malformed or budget-exhausted walks are rejected rather than guessed ordinary; unknown private vendor RAW schemes may remain indistinguishable from ordinary TIFF. Same gate covers TIFF stills inside Live Photo bundles. Original accepted bytes remain unchanged.

Phone DNG/Apple ProRAW is supported by the iOS importer, not by passing RAW through this TIFF gate. Photos and Files imports render the DNG with Apple's native RAW decoder into a JPEG attachment (maximum 4096-pixel edge), leaving the source unchanged. The importer bounds source files to 512 MiB and 64 MP, and JPEG output to 32 MiB. Existing JPEG/HEIC/GIF imports retain their original formats; DSLR-specific RAW support is not provided. Import failures surface as reason-specific, dismissible dialogs.

Stdout is one binary frame:

```text
4-byte unsigned big-endian JSON length
UTF-8 JSON header
exactly header.contentLength response bytes
```

Header schema:

```json
{"version":1,"requestId":"uuid","status":200,"contentType":"image/png","contentLength":123,"headers":{"X-Sentient-Page":"1"},"error":null}
```

Consumer must cap JSON header at configured 16 KiB, validate fields, cap total body at configured 16 MiB, require exact EOF after body, and inspect Docker exec exit status. Host transport discards parser/client stderr; never log it.

Cancel an active request with a second argv-only exec:

```text
python3 /app/exec_client.py cancel REQUEST_UUID
```

Cancel verifies PID ownership through `/proc/<pid>/cmdline`, sends `SIGTERM`, and closes client's UDS. Server observes disconnect and kills active decoder. Client and server deadlines remain backstops if adapter cancellation fails.

## Host Docker CLI transport guidance

Gateway spawns host Docker CLI with argv only; no shell:

```text
docker exec -i sentient-attachment-parser python3 /app/exec_client.py request REQUEST_UUID OPERATION MEDIA_TYPE CONTENT_LENGTH [OPTIONS]
```

Stream bounded input to child stdin and close it at exactly `CONTENT_LENGTH`. Docker CLI owns Docker stream demultiplexing and propagates stdout EOF. Ignore child stderr; never log parser output or attachment content. Require exact framed EOF and inspect child exit status.

On `AbortSignal` or adapter deadline, first launch bounded argv-only cancellation:

```text
docker exec sentient-attachment-parser python3 /app/exec_client.py cancel REQUEST_UUID
```

Validate its framed acknowledgement, then terminate and boundedly force-kill owned host CLI subprocesses. Never interpolate filenames, media, operation, page values, IDs, or container identity into shell text. Production launchd PATH omits `/usr/local/bin`; transport resolves executable Docker paths, including Docker Desktop's standard host install paths.

## Internal HTTP API

Exec client alone calls these UDS endpoints with raw bytes, exact `Content-Type`, and required `Content-Length`:

- `GET /health` — returns `status: "ok"` plus manifest metadata
- `POST /v1/pdf/header`
- `POST /v1/pdf/text?first_page=1&last_page=N`
- `POST /v1/pdf/render?page=N&max_edge=1600`
- `POST /v1/image/header`
- `POST /v1/image/normalize?max_edge=1600`

Responses/errors are bounded. Decoder stderr and attachment content are discarded, never logged. No OCR.

## Image labels

Release builds pass manifest identity fields and source revision as Docker build arguments:

```text
ADDON_NAME
ADDON_VERSION
ADDON_PROTOCOL_VERSION
ADDON_REVISION
```

Dockerfile maps them to `org.opencontainers.image.title`,
`org.opencontainers.image.version`, `org.opencontainers.image.revision`,
`io.sentient.addon.name`, `io.sentient.addon.version`, and
`io.sentient.addon.protocol-version`.

## Installation

Production compose includes the image under its existing `build-only` profile. Runtime lifecycle belongs to the gateway supervisor, not compose. Gateway release packaging includes `templates/services/attachment-parser.yaml` through the existing templates copy.

Existing operator config is preserved during upgrades. Add the `managed_services.attachment-parser` entry from `gateway/config.yaml` before enabling the addon; do not replace operator config wholesale. The same file documents `attachments` budgets, `history` retention, and `orchestrator.auxiliary.attachment_vision_model`. Build the addon image before restarting through the approved deployment path. This README does not authorize a production deployment.

## Isolated check

```sh
docker build -t sentient/attachment-parser:probe-$USER gateway/addons/attachment-parser
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1280m \
  --user 65534:65534 --memory 2g --memory-swap 2g --cpus 1 --pids-limit 32 \
  --cap-drop ALL --security-opt no-new-privileges sentient/attachment-parser:probe-$USER /app/test.sh
```

Real single-decoder queue regression (creates and removes uniquely named, network-isolated containers; never touches managed parser):

```sh
python3 gateway/addons/attachment-parser/tests/test_tmpfs_concurrency.py
```

Regression overlaps two valid PNG requests above 19 MiB each and verifies both complete through one decoder slot under configured finite workspace/memory, non-root, read-only, capability, PID, and CPU restrictions.
