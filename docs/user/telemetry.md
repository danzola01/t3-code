# Product usage data

Outbound telemetry is disabled by default in this fork. `T3CODE_DISABLE_TELEMETRY=true`
(the default) blocks T3 Code product analytics and OTLP exports on the server and desktop app,
and forces telemetry off in Gemini CLI processes launched by T3 Code. Set it in the host
environment before starting T3 Code to make the choice explicit. A desktop WSL backend receives
the setting too.

Local usage estimates and CPU/memory diagnostics remain available. Gemini CLI sessions started
outside T3 Code use their own [telemetry settings](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md).

To allow configured exports, set `T3CODE_DISABLE_TELEMETRY=false`. Product analytics still require
`T3CODE_TELEMETRY_ENABLED=true`.

When enabled, the T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

`T3CODE_TELEMETRY_ENABLED=false` also stops product events, independently of the global switch.

The desktop app reads the variable from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.
