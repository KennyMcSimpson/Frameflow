# Frameflow Studio Privacy Notice

*English translation of [docs/PRIVACY.md](PRIVACY.md). Last updated: November 2026.*

Frameflow Studio (the "Software") is a local desktop application that runs directly on your computer. Your projects, media assets, and exported videos are stored on your own device. We do not operate an account system, we do not run first-party servers, and we do not collect your personal information.

## What We Do Not Do

- We do not collect usage analytics, send telemetry, or display advertisements.
- We do not upload your projects, media assets, or exported videos to any server operated by us.
- When errors occur, diagnostic logs are written locally on your device and are never uploaded automatically.
- The Software does not automatically check for or download updates in the background.

## Data Stored on Your Computer

- **Settings & API Keys:** Stored in `%APPDATA%\Frameflow`. `settings.json` holds your preferences; `secrets.json` stores any API keys you enter, encrypted using the Windows operating system encryption API (`safeStorage` / DPAPI) so that only the current Windows user account can decrypt them.
- **Runtime Logs:** Stored in `%APPDATA%\Frameflow\logs` to help diagnose issues. Before writing to disk, API keys, authorization credentials, and your Windows user directory name are redacted to placeholders. Logs are never shared unless you explicitly send them yourself.
- **On-Demand Tools & Models:** Optional components such as `yt-dlp`, `whisper.cpp`, and local speech recognition models are stored in the `bin` and `models` folders under `%APPDATA%\Frameflow`.
- **Projects & Media:** Stored in `Documents\Frameflow` by default (configurable in Settings), including project files, media libraries, shot breakdown analyses, and caches (thumbnails, waveforms, and preview/proxy files).
- **Temporary Files:** Media processing uses a `frameflow` directory inside your system temporary folder, which can be safely cleared at any time.

Uninstalling the Software preserves these data directories by default so you can resume your work if you reinstall later. To remove all local data permanently, manually delete the folders listed above after uninstalling.

## When the Software Connects to the Internet

The Software accesses the network **only** when you actively use one of the online features below, and transmits only the data required to fulfill that request to the chosen service:

- **AI Writing, Director Assistant & Shot Breakdown Analysis:** Sends your text prompts, relevant project descriptions, and screenshots of frames you select to the AI service configured in Settings (OpenAI by default, or an OpenAI-compatible endpoint you specify). If you opt in to use ChatGPT login via your local Codex CLI, requests are sent to OpenAI through that CLI tool.
- **AI Image Generation:** Sends your image prompts and selected reference images to the image provider you configure: Volcengine Ark (Seedream image model) or an OpenAI-compatible image endpoint.
- **Cloud vs. Local Speech-to-Text (ASR):** Cloud transcription uploads extracted audio to the OpenAI speech recognition API (or your configured compatible endpoint). If you choose **Local Transcription**, the Software downloads `whisper.cpp` from GitHub and Whisper ggml models from Hugging Face on first use; after that, all transcription runs entirely on your device and audio never leaves your computer.
- **Stock Media Search & Download:** Sends your search queries to open-license media libraries that require no API key: Wikimedia Commons, Openverse, Internet Archive, and the NASA Image and Video Library. Pexels and Pixabay are contacted **only** if you explicitly enter their API keys in Settings. Preview thumbnails and assets you choose to download are fetched from each provider's servers or CDNs.
- **Video URL Download & Video Site Search:** Downloads `yt-dlp` from GitHub on first use, then queries or downloads from the video site corresponding to the URL or search terms you provide (such as YouTube or Bilibili).
- **AI Video Generation:** Sends your prompts and optional reference images to the video generation service you select: Volcengine Ark (Seedance), Volcengine Jimeng AI, Kuaishou Kling, MiniMax Hailuo, Runway, Google Veo, OpenAI Sora, Luma, or fal.ai.
- **Opening External Links:** Clicking help, documentation, or license links opens them in your system's default web browser.

These third-party services process the content you send under their own privacy policies and terms of service, and any usage fees are billed directly between you and the provider. Please send only content you have the right to use and review each service's terms before enabling it.

## Your Controls

- You can edit timelines and export videos completely offline without entering any API keys or using online features.
- You can remove saved API keys at any time in Settings.
- You can delete your projects, media library, caches, and logs from disk at any time.

## Children

The Software is not directed at children under 14 years of age and does not knowingly collect personal information from children.

## Changes

Any updates to this notice will ship alongside new releases and be highlighted in the release notes.
