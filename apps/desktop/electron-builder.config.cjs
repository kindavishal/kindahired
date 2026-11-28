// electron-builder settings. The app's id, name and GitHub repo live in app.config.json, so a
// rename happens there only.
const app = require("./app.config.json");

const env = process.env;
// Signing needs a Developer ID certificate (CSC_LINK, a base64 .p12 or a path, with
// CSC_KEY_PASSWORD). Without one the app is signed ad hoc, which runs on the computer that built it.
const signed = Boolean(env.CSC_LINK);
// Notarizing needs an App Store Connect API key: APPLE_API_KEY (the .p8 file's path),
// APPLE_API_KEY_ID and APPLE_API_ISSUER. It only makes sense for a signed build.
const notarize = signed && Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);

if (process.platform === "darwin" && !signed) {
  console.log("No CSC_LINK: building an unsigned (ad hoc) app that isn't notarized.");
}

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: app.appId,
  productName: app.productName,
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**", "renderer/**", "assets/**", "package.json", "!**/*.map"],
  artifactName: "${productName}-${version}-${arch}.${ext}",
  // kindahired://open/<path> links open that dashboard page in the app.
  protocols: [{ name: app.productName, schemes: ["kindahired"] }],
  publish: [{ provider: "github", owner: app.github.owner, repo: app.github.repo, releaseType: "release" }],
  mac: {
    target: [
      { target: "dmg", arch: ["universal"] },
      // The zip is what auto-update downloads.
      { target: "zip", arch: ["universal"] },
    ],
    category: "public.app-category.productivity",
    icon: "build/icon.png",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // "-" is an ad hoc signature: no certificate, nothing looked up in the keychain.
    identity: signed ? undefined : "-",
    notarize,
  },
  dmg: { artifactName: "${productName}-${version}.${ext}" },
  linux: {
    target: ["AppImage", "deb"],
    category: "Office",
    icon: "build/icon.png",
    executableName: app.productName,
    maintainer: app.linuxMaintainer,
    synopsis: "Runs your own Claude Code for your job-search hub.",
  },
  // Unsigned for now: Windows shows a SmartScreen prompt on first install (More info, then Run
  // anyway). Updates install without it. To sign later, add a certificate (CSC_LINK for a .pfx, or
  // win.azureSignOptions for Azure Trusted Signing).
  win: {
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    icon: "build/icon.png",
  },
  nsis: {
    // A per-user install: no administrator prompt, and auto-update can replace it.
    oneClick: true,
    perMachine: false,
    // x64 and arm64 go in one installer, which picks the right one, so there's one file to download
    // and one latest.yml for updates.
    artifactName: "${productName}-Setup-${version}.${ext}",
    shortcutName: app.productName,
  },
  // The Microsoft Store package: built with `--win appx`, uploaded to Partner Center by hand, and
  // signed by the Store. The identity comes from Partner Center (Product identity page) via
  // app.config.json; until it's filled in, the package is only good for a local test install.
  // See docs/windows-store.md.
  appx: {
    ...(app.windowsStore.identityName && { identityName: app.windowsStore.identityName }),
    ...(app.windowsStore.publisher && { publisher: app.windowsStore.publisher }),
    publisherDisplayName: app.windowsStore.publisherDisplayName || "kindavishal",
    displayName: app.productName,
    applicationId: app.productName,
    backgroundColor: "transparent",
    languages: ["en-US"],
    // Electron needs Windows 10 1809 or later; tested on Windows 11 24H2.
    minVersion: "10.0.17763.0",
    maxVersionTested: "10.0.26100.0",
    // electron-builder's own startup entry hard-codes another app's task id, so ours is in
    // build/appx-extensions.xml. The kindahired:// protocol comes from `protocols` above.
    addAutoLaunchExtension: false,
    customExtensionsPath: "build/appx-extensions.xml",
    artifactName: "${productName}-${version}-store-${arch}.${ext}",
  },
  deb: { depends: ["libnotify4", "libxtst6", "libnss3", "libsecret-1-0"] },
};
