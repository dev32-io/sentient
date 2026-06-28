// Merge the just-deployed platform block into the existing manifest JSON.
// Inputs via env (see deploy-mobile.sh). Prints the merged manifest to stdout.
const prev = JSON.parse(process.env.EXISTING || "{}");
const plat = process.env.PLAT;
if (plat === "android") {
  prev.android = {
    versionCode: Number(process.env.ANDROID_VERSION_CODE),
    versionName: process.env.ANDROID_VERSION_NAME,
    minSupportedBuild: Number(process.env.ANDROID_MIN_BUILD || 0),
    url: "/download/android/latest.apk",
    notes: "",
  };
} else if (plat === "ios") {
  prev.ios = {
    bundleVersion: Number(process.env.IOS_BUNDLE_VERSION),
    shortVersion: process.env.IOS_SHORT_VERSION,
    minSupportedBuild: Number(process.env.IOS_MIN_BUILD || 0),
    bundleId: process.env.IOS_BUNDLE_ID,
    url: "/download/ios/latest.ipa",
    manifestUrl: "/download/ios/manifest.plist",
    notes: "",
  };
}
process.stdout.write(JSON.stringify(prev, null, 2));
