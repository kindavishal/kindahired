# kindahired in the Microsoft Store

The Store version of the desktop app is an AppX package. The Store signs it, so it needs no code
signing certificate and Windows shows no SmartScreen warning. The `.exe` from GitHub Releases stays
as the direct download.

What's different in the Store version (`distribution()` in `apps/desktop/src/settings.ts`):

- **Updates** come from the Store. The app's own updater is off and the tray has no "Check for
  updates".
- **Open at login** is a startup task in the package (`apps/desktop/build/appx-extensions.xml`). The
  person switches it in Windows Settings › Apps › Startup; the app's settings window says so.
- **`kindahired://` links** are declared in the package, so the app doesn't register them itself.

Registering as a developer is free for individuals (since September 2025). Microsoft verifies who you
are with a government ID and a selfie.

## 1. Open a developer account

1. Go to https://storedeveloper.microsoft.com and choose **Get started for free**. Other entry points
   (Partner Center, Visual Studio) may still show the old paid sign-up.
2. Choose **Individual developer** and sign in with a personal Microsoft account (not a work or
   school account).
3. Finish the identity check: a government ID and a selfie. Wait for it to be approved.

## 2. Reserve the name and copy the identity

1. Open Partner Center: https://partner.microsoft.com/dashboard/apps-and-games/overview
2. **New product › MSIX or PWA app**, and reserve the name **kindahired**.
3. In the new product, open **Product management › Product identity**. Copy these three values into
   `apps/desktop/app.config.json` under `windowsStore`:

   | Partner Center | `windowsStore` field |
   |---|---|
   | Package/Identity/Name | `identityName` |
   | Package/Identity/Publisher (starts with `CN=`) | `publisher` |
   | Package/Properties/PublisherDisplayName | `publisherDisplayName` |

   Commit and merge that change. A package built without these values installs locally for testing
   but Partner Center rejects it.

## 3. Build the package

- **Between releases:** GitHub › Actions › **Windows Store package** › **Run workflow**. Leave the
  version empty to use `apps/desktop/package.json`'s, or give one (MAJOR.MINOR.PATCH, higher than the
  last one you uploaded). When it finishes, download the `microsoft-store-<n>` artifact from the run.
- **Each release** (`desktop-v*` tag) also builds one, as the `microsoft-store-desktop-v<version>`
  artifact on that release run.

The artifact holds two packages: `kindahired-<version>-store-x64.appx` and `…-arm64.appx` (names may
differ slightly). Upload both.

## 4. Try it on your Windows laptop first

An unsigned package can't be installed by double-clicking, but Developer Mode can register it:

1. Windows Settings › System › For developers › turn on **Developer Mode**.
2. Rename the `.appx` for your laptop's architecture to `.zip` and extract it to a folder.
3. In that folder, delete `AppxSignature.p7x` if it's there.
4. In PowerShell, in that folder: `Add-AppxPackage -Register .\AppxManifest.xml`
5. Open **kindahired** from the Start menu and check:
   - sign in, the Claude Code check, and one full pack;
   - a `kindahired://open/` link opens the app;
   - the settings window points to Windows Settings for opening at login, and kindahired is listed
     in Settings › Apps › Startup;
   - the tray menu has no "Check for updates".
6. Remove it afterwards with Settings › Apps › Installed apps › kindahired › Uninstall, so it doesn't
   clash with the Store install later.

## 5. Fill in the submission

In Partner Center, open the product and **Start your submission**. Section by section:

### Pricing and availability

- **Markets:** all markets, or the ones early access covers.
- **Visibility:** for early access, either
  - **Public audience** with **Make this product available but not discoverable in the Store**
    (anyone with the link can install it; it doesn't show in search), or
  - **Private audience**, with the Microsoft account emails of your testers.
  Switch to discoverable at launch.
- **Pricing:** Free.

### Properties

- **Category:** Productivity. **Subcategory:** none.
- **Privacy policy URL:** https://kindahired.kindavishal.dev/privacy.html
- **Website:** https://kindahired.kindavishal.dev
- **Support contact:** hired@kindavishal.dev
- **Product declarations:** the app doesn't depend on non-Microsoft drivers or NT services. It does
  access the internet.
- **System requirements:** none beyond the defaults. In the notes, say it needs Claude Code installed.

### Age ratings

Fill in the IARC questionnaire. kindahired has no violence, sexual content, gambling or user-to-user
chat, and doesn't share the person's location. It does handle personal information and has no
in-app purchases. The usual result is 3+/Everyone.

### Packages

Upload both `.appx` files. Device family: **Windows 10/11 Desktop**. Partner Center reads the
version, architectures and capabilities from the packages.

### Store listings (English)

- **Description:**

  > kindahired turns every job posting into a pack you can act on: an honest fit read, the real apply
  > link, a tailored resume, a cover note, and the right people to contact with drafted messages. It
  > prepares everything; you still press send.
  >
  > This app runs the Claude Code steps for your kindahired account on your own computer, with your own
  > Claude plan, and opens your kindahired dashboard.
  >
  > You need:
  > • a kindahired account (early access: request one at kindahired.kindavishal.dev)
  > • Claude Code for Windows, signed in to your Claude account (claude.com/claude-code). A copy inside
  >   WSL won't work with the app.

- **What's new in this version:** "First release in the Microsoft Store."
- **Product features** (one per line):
  - Every posting becomes a pack: fit read, apply link, resume, cover note and contacts
  - Runs on your own Claude plan, on your own computer
  - Sits in the system tray and works in the background
  - Never applies or sends anything for you
- **Screenshots:** at least one, 1366×768 or larger. Take them on your laptop: the dashboard window
  with a pack open, the settings window, and the tray menu.
- **Store logos:** a square 1:1 logo (300×300 at least; 1080×1080 is safest). Use
  `site/brand/icon-1024.png` scaled to 1080×1080 on a transparent background.
- **Search terms:** job search, resume, cover letter, job applications, Claude Code.
- **Copyright:** © 2026 kindahired.

### Submission options

- **Restricted capabilities:** Partner Center asks why the package uses `runFullTrust`. Answer:

  > kindahired is a desktop (Win32/Electron) app packaged for the Store. It needs full trust to run
  > the user's own installed Claude Code command-line tool, which does the work for their kindahired
  > account, and to sit in the system tray.

- **Notes for certification:** reviewers need to be able to sign in. Create a test account first
  (add-person on the hub, with an inbox you can read or that forwards to you), then write:

  > kindahired needs a kindahired account and Claude Code (https://claude.com/claude-code) signed in
  > to a Claude plan.
  > Test account: <email>. Sign-in sends a one-time code to that email; reply to this note or email
  > hired@kindavishal.dev and we'll send the code within working hours.
  > Without Claude Code installed, the app opens the dashboard and shows "Claude Code isn't installed"
  > with a link to install it; that's expected.
  > The app sits in the system tray: right-click the kindahired icon for its menu.

  Since codes go by email, the reviewer may not be able to sign in unattended. If certification fails
  on sign-in, ask me to add a reviewer sign-in (a fixed code for one test address).

Then **Submit for certification**. It usually takes a few business days; Partner Center emails you
the result.

## 6. After it's live

- Partner Center › Product management › Product identity shows the **Store ID** and the Store link
  (`https://apps.microsoft.com/detail/<Store ID>`). Send me the Store ID and I'll point the Windows
  download button on the site and the hub's "Get the app" page at the Store, with the `.exe` as the
  other option.
- **Each new version:** build the package (step 3) with a higher version, then in Partner Center
  **Update** the submission, replace the packages, update "What's new", and submit. The Store
  delivers it to installed copies.
