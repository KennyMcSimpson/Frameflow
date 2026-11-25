# Security Policy

## Supported Versions

Security fixes are maintained on the latest release branch of Frameflow Studio:

| Version | Supported |
| --- | --- |
| `2.0.x` | Yes |
| `< 2.0.0` | No |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them privately via [GitHub Security Advisories](https://github.com/KennyMcSimpson/frameflow-studio/security/advisories/new) on this repository. Include:

- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal proof of concept.
- Affected files, IPC channels, or Electron/packaging configuration (if known).
- Any suggested mitigations.

We aim to acknowledge reports within **72 hours** and provide a remediation plan or status update within **7 days**. Coordinated disclosure is appreciated so users have a patched release before public details are published.

## Security Model & Hardening Highlights

Frameflow Studio is designed as a **local-first desktop application** with defense-in-depth across the Electron boundary:

- **Renderer Isolation:** `contextIsolation: true`, `sandbox: true` (`app.enableSandbox()`), `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`, `webviewTag: false`, and `navigateOnDragDrop: false`.
- **Content Security Policy:** Strict production CSP restricts script execution to `'self'`, blocks frames/objects/forms, and sets `connect-src 'self' ffmedia:` to block direct renderer XHR/fetch/WebSocket calls to external APIs, while `img-src` and `media-src` permit `https:` for stock-media thumbnail and preview rendering.
- **IPC Sender Validation:** Every `ipcMain.handle` rejects calls that do not originate from the main frame of the local application bundle (or loopback dev server when unpackaged). `FF_DEV_URL` is ignored in packaged builds.
- **Scoped `ffmedia://` Protocol:** Local file streaming is restricted to explicitly registered media paths and designated application data/cache directories; all other paths return `403`.
- **Shell & Navigation Guards:** Popup windows, cross-origin navigations, and redirects are denied; external links only open `https:` URLs in the system browser; `shell:openPath` enforces an 18-extension allowlist (`ALLOWED_OPEN_EXT`) with fail-closed `realpath` resolution, UNC path rejection, and trailing dot/space protection.
- **Credential Protection:** User-supplied API keys are encrypted at rest via Electron `safeStorage` (Windows DPAPI) in `%APPDATA%\Frameflow\secrets.json`, never returned in plaintext over IPC, and scrubbed from logs via `log.redact()`.
- **Electron Fuses:** Release binaries enforce `RunAsNode=DISABLE`, `EnableNodeOptionsEnvironmentVariable=DISABLE`, `EnableNodeCliInspectArguments=DISABLE`, `EnableEmbeddedAsarIntegrityValidation=ENABLE`, and `OnlyLoadAppFromAsar=ENABLE`, verified on every build by `scripts/check-artifacts.mjs`.
- **Binary & Supply-Chain Integrity:** Packaged FFmpeg binaries are fetched from a pinned LGPL v3 release and checked against a hardcoded SHA-256 digest before packaging (`scripts/fetch-ffmpeg.mjs`).

## Out-of-Scope / User-Controlled Risks

- Third-party AI, video generation, stock, or video-hosting APIs explicitly configured by the user (governed by each provider's own security and privacy terms).
- Local compromise of the active Windows user session (e.g., malware running as the same Windows user can access DPAPI-encrypted user data).
