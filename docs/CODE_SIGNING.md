# Code signing policy

Sitara is free, open-source software (GPL-3.0-or-later). Its installers are built only by the GitHub Actions
workflow in this repository (`.github/workflows/release.yml`), directly from the tagged source. Nobody builds
release binaries on a personal machine.

## Windows

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

- **Committers and reviewers:** [members of this repository](https://github.com/sunderbharath85/sitara/graphs/contributors). Every change reaches `main` through a reviewed commit.
- **Approvers:** [@sunderbharath85](https://github.com/sunderbharath85) approves each release before it is signed.

Until the SignPath Foundation certificate is active, Windows installers are unsigned. SmartScreen may show
"Windows protected your PC": choose **More info → Run anyway**, or verify the file first (see below).

## macOS

Apple notarization needs a paid Apple Developer membership, so builds are ad-hoc signed and not notarized.
On first launch, macOS says it can't verify the developer:

1. Open the app once (it will be blocked), then go to **System Settings → Privacy & Security** and choose
   **Open Anyway**; or
2. In Terminal: `xattr -dr com.apple.quarantine /Applications/Sitara.app`

## Linux

`.deb`, `.rpm` and `.AppImage` builds are not signed; verify them as below.

## Verifying a download (every platform)

Each installer carries a build-provenance attestation from GitHub (Sigstore), proving it was built by this
repository's release workflow from a specific commit:

```sh
gh attestation verify Sitara_0.1.0_x64-setup.exe --repo sunderbharath85/sitara
```

## Downloads Sitara makes at runtime

Sitara only connects to the internet when you ask it to:

- **Optional AI features** download ONNX Runtime and model files from their public sources (GitHub releases of
  microsoft/onnxruntime and Hugging Face) the first time you turn a feature on. Every file is checked against a
  SHA-256 digest pinned in the source code before it is used. Turning a feature off deletes its files.
- **"Open in OpenStreetMap"** opens your browser when you click it.

## Privacy

This program will not transfer any information to other networked systems unless you specifically ask it to. Your
photos and the data learned from them never leave your computer.
