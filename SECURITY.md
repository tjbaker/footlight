# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub instead:
[**Report a vulnerability**](https://github.com/tjbaker/footlight/security/advisories/new)
(Security tab → "Report a vulnerability").

Please include:

- what is affected: the engine/CLI, the desktop app, or the dev server (`app/dev-server`);
- the version or commit;
- steps or a minimal manifest/input that reproduces it;
- the impact you expect.

You should get an acknowledgement within a week. Fixes are developed in a private
advisory and released before the details are published. Reporters are credited
unless they prefer not to be.

## Supported versions

Footlight is pre-1.0. Only the **latest release** gets security fixes; please
reproduce against it (or `main`) before reporting.

## Scope

In scope:

- the render engine and `footlight` CLI (`src/`), including how manifest values
  reach ffmpeg (argument arrays, filtergraph strings, ASS files, temp files);
- the Tauri desktop app (`app/src`, `app/src-tauri`): IPC commands, the asset
  protocol, CSP, and secret storage;
- the web dev backend (`app/dev-server/server.mjs`). It is a development tool,
  but it runs on developers' machines, so exposure beyond localhost is in scope;
- handling of bring-your-own API keys for AI tracking.

Out of scope:

- vulnerabilities in `ffmpeg`/`ffprobe` themselves; report those
  [upstream](https://ffmpeg.org/security.html);
- third-party AI providers' services;
- issues that require an attacker who already controls the local user account.

## Design notes

- **No telemetry.** Footlight does not phone home.
- **BYOK.** API keys are never shipped. The desktop app keeps them in the OS
  keychain, and they are sent only to the provider you configure.
- **No shell.** Subprocesses are spawned with argument arrays, never through a shell.
