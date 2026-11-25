# opencode-kiro

An **Agent Client Protocol (ACP)**-compliant **Kiro** provider plugin for **OpenCode 2.x** with native `kiro-cli login` authentication, dynamic model discovery, strict provider ownership, and live TUI credits display.

All requests go directly to `kiro-cli acp` over JSON-RPC 2.0 `stdio` — **identical to Kiro's own IDE clients (Zed, JetBrains)** — with **zero credential scraping** and **zero credential reuse** against any other provider.

## Features

- **Full ACP JSON-RPC 2.0 Transport (`src/acp/`)**:
  - Spawns `kiro-cli acp` (`shell: false`) with bounded stderr capture, SIGTERM → SIGKILL lifecycle supervision, and clean `dispose()`.
  - Implements `initialize`, `authenticate`, `session/new`, `session/set_model` (with automatic v3 fallback to `session/set_config_option`), `session/prompt`, `session/cancel` (on `AbortSignal`), inbound `session/update` streaming, and `session/request_permission` policy handling (`deny_by_default` by default).
  - Supports Kiro ACP extensions: `_kiro.dev/metadata` (including `kiro-cli 3.6+` `meteringUsage` credit deltas and `contextUsagePercentage`) and `_kiro/account/getUsage`.
- **Native `kiro-cli login` Auth (`src/auth/`)**:
  - Delegates 100% of authentication to `kiro-cli login` and `kiro-cli whoami --format json`.
  - **Zero credential scraping**: never reads `~/.kiro`, SQLite databases, macOS Keychain, `~/.aws`, or extracts raw OAuth/JWT/API tokens.
  - **Strict isolation**: `auth.loader` refuses any provider ID other than `"kiro"`.
- **Dynamic Model Discovery (`src/discovery/`)**:
  - Discovers available Kiro models from ACP `session/new` (`availableModels` / `configOptions`) and `kiro-cli chat --list-models --format json` (with plain-text table fallback), normalized to `kiro/<model-id>` with TTL caching.
- **Strict Provider Ownership (`src/provider/`)**:
  - Registers and owns `providers.kiro` in OpenCode 2.x config without mutating other providers.
  - Rejects foreign provider prefixes (`openai/*`, `anthropic/*`), bare foreign provider names, nested prefixes (`kiro/openai/*`), and prototype-pollution keys.
  - Exposes an AI SDK v2-compatible `KiroAcpLanguageModel` (`doGenerate` and `doStream`).
- **OpenCode 2.x TUI Credits Display (`src/tui.tsx`, `src/tui/`)**:
  - Registers `sidebar_footer`, `sidebar_content`, and `app_bottom` slots via `api.slots.register(...)` showing live Kiro credit usage, progress bar, warning/critical thresholds, context window %, active model, and billing reset date.
  - Registers slash commands: `/kiro-credits`, `/kiro-login`, `/kiro-models`, and `/kiro-status`.
  - Communicates with the server plugin over the typed `./rpc` contract (`src/rpc.ts`) and sanitizes/redacts all display output.

## Installation & OpenCode 2.x Configuration

```bash
opencode plugin add opencode-kiro
```

Or register in `opencode.json` / `opencode.jsonc`:

```json
{
  "plugins": [
    "opencode-kiro"
  ]
}
```

### Prerequisites

1. Install Kiro CLI:
   ```bash
   brew install --cask kiro-cli
   # or: curl -fsSL https://cli.kiro.dev/install | bash
   ```
2. Sign in natively via Kiro CLI:
   ```bash
   kiro-cli login
   ```
3. Verify your session:
   ```bash
   kiro-cli whoami --format json
   ```

## Package Exports (OpenCode 2.x Multi-Surface)

| Export | Entrypoint | Purpose |
| --- | --- | --- |
| `.` | `src/index.ts` | OpenCode 2.x Server Plugin (`id: "opencode-kiro"`, `server`, `setup`) |
| `./tui` | `src/tui.tsx` | OpenCode 2.x TUI Plugin (`sidebar_footer`, `sidebar_content`, `app_bottom`, slash commands) |
| `./rpc` | `src/rpc.ts` | Shared typed RPC contract between Server and TUI |
| `./provider` | `src/provider/index.ts` | ACP-backed `KiroAcpLanguageModel` and strict provider ownership guards |

## Development & Testing

```bash
# Run the full adversarial test suite (114 tests across ACP, Auth/Discovery, Provider/Server, TUI)
bun test
```

## Security Guarantees

1. **No Credential Scraping**: Zero reads of Kiro credential stores, SQLite databases, Keychain, or AWS SSO caches.
2. **No Cross-Provider Credential Reuse**: Kiro auth and transport are hard-locked to `provider === "kiro"`.
3. **No Shell Injection**: All `kiro-cli` invocations use `spawn(..., { shell: false })` with strict `cliPath` validation.
4. **Display Redaction**: TUI output strips C0/C1 ANSI escape sequences and redacts bearer tokens, JWTs, API keys, and secret key-value pairs.
