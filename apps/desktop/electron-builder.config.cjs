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
  deb: { depends: ["libnotify4", "libxtst6", "libnss3", "libsecret-1-0"] },
};
