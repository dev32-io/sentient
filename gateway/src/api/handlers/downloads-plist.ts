interface IosBlock {
  bundleVersion: number;
  shortVersion: string;
  bundleId: string;
  url: string;
}

const ICON_57 = "/download/ios/icon-57.png";
const ICON_512 = "/download/ios/icon-512.png";

/** Builds an itms-services manifest.plist from the release manifest.
 *  All asset URLs are absolute HTTPS (itms-services requires it). */
export function renderItmsPlist(manifest: unknown, publicBaseUrl: string): string {
  const ios = (manifest as { ios: IosBlock }).ios;
  const base = publicBaseUrl.replace(/\/$/, "");
  const abs = (p: string): string => `${base}${p}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array>
<dict><key>kind</key><string>software-package</string><key>url</key><string>${abs(ios.url)}</string></dict>
<dict><key>kind</key><string>display-image</string><key>url</key><string>${abs(ICON_57)}</string></dict>
<dict><key>kind</key><string>full-size-image</string><key>url</key><string>${abs(ICON_512)}</string></dict>
</array>
<key>metadata</key><dict>
<key>bundle-identifier</key><string>${ios.bundleId}</string>
<key>bundle-version</key><string>${ios.shortVersion}</string>
<key>kind</key><string>software</string>
<key>title</key><string>Sentient</string>
</dict></dict></array></dict></plist>`;
}
