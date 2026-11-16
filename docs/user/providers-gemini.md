# Gemini CLI

T3 Code can run Gemini CLI as a provider through Gemini's Agent Client Protocol (ACP) mode. The
Gemini provider supports conversations, streamed responses and reasoning, tool approvals, images,
model switching, session resume and cancellation, MCP servers, skills, custom commands, and T3 Code
workflow scripts.

## Before You Add The Provider

Gemini CLI 0.59.0 through 0.64.0 have compatibility coverage. Prefer 0.64.0 for improved saved-session lookup.

Install Gemini CLI on the machine running the T3 Code environment, then start `gemini` once in a
terminal and complete your company's approved sign-in flow. T3 Code uses Gemini CLI's existing
credentials; it does not ask for or store a Google credential itself.

In T3 Code, open Settings, add a provider, and choose **Gemini**. The default binary path is
`gemini`.

The **ACP authentication method** can normally stay empty. T3 Code first respects the authentication
method saved by Gemini CLI, then considers Gemini's authentication environment variables, and falls
back to an advertised method. Set the field explicitly when an administrator requires one of
`oauth-personal`, `gemini-api-key`, `vertex-ai`, or `gateway`.

For Google sign-in, the explicit method is `oauth-personal`. Availability checks verify that the
CLI supports ACP without signing in or starting a conversation. Authentication and project MCP
connections are checked when a thread starts; that session also supplies the available models.
You can change models in an existing thread.

## Separate Work And Personal Setups

Set **GEMINI_CLI_HOME path** on each provider instance to keep its Gemini settings, credentials,
commands, and skills separate. For example, one instance can use `~/.gemini-work` and another can
use `~/.gemini-personal`.

Authenticate each home from a terminal before using it in T3 Code:

```sh
GEMINI_CLI_HOME="$HOME/.gemini-work" gemini
```

Environment variables configured on the provider instance are passed only to that Gemini process.
This is the right place for company-specific Vertex AI, API-key, gateway, or proxy settings.

## Trust And Permission Modes

Gemini CLI's trusted-folder checks remain active. If a project is not trusted, trust it with Gemini
CLI before starting the thread. Enable **Skip workspace trust check** on the provider instance
only when you want every project opened by that instance to be trusted automatically.

Enable **Enable sandbox** to isolate Gemini's tool execution, and use **Policy path** to load a
Gemini policy file or directory. Existing options in **Launch arguments** take precedence over
these instance settings. Plan mode starts Gemini in its native read-only approval mode and
returns to the thread's build permission mode when you leave the plan. T3 Code's permission mode
also overrides permissive approval flags in **Launch arguments** when starting or continuing a session.

T3 Code maps Gemini ACP tool permission requests into the same approval UI used by other providers.
Full Access automatically selects an allow option when Gemini offers one; other modes continue to
show the request. Approval choices follow the options Gemini offers. For MCP tools, session
approval applies to that tool; it does not grant access to every tool on the server or future sessions.

## MCP

Gemini's own MCP configuration continues to work normally. T3 Code also attaches its per-thread MCP
server over ACP, so Gemini can use T3 Code tools without writing credentials or endpoints into the
project.

Gemini MCP activity rows show the server, tool arguments, and a compact result preview when the
CLI supplies those details. Gemini CLI 0.64.0 sends some MCP calls as display text without the
server identity or structured arguments; these appear as ordinary tool activity with Gemini's
title and result. MCP execution and approvals still work. Large responses stay summarized when
a thread is sent to another client.

Gemini CLI 0.59.0 does not expose the interactive `/mcp` commands over ACP. T3 Code explains this
when you enter `/mcp list` rather than asking the model to invent a status report. Run
`gemini mcp list` from the same project directory, home, and environment, or use `/mcp list` in
interactive Gemini CLI. These commands list MCP servers and tools, not language models. A separate
terminal session does not include the temporary T3 Code MCP server attached to your thread.

When Gemini publishes a new topic with its built-in `update_topic` tool, T3 Code renames the thread
to that topic so the sidebar stays aligned with Gemini's current work.

## Skills And Custom Commands

Gemini skills are discovered from `.gemini/skills` and `.agents/skills` in the active Gemini home
and trusted project, including skills added with `gemini skills link <path>`. Project skills take
precedence over home skills, and `.agents/skills` takes precedence over `.gemini/skills` at each level.
Disabled skills in Gemini's user, trusted-project, and system settings stay disabled. Selecting a skill from T3 Code asks
Gemini to load it through the `activate_skill` tool.

TOML commands under `$GEMINI_CLI_HOME/.gemini/commands` (or `~/.gemini/commands` when no custom
home is set) and the project's `.gemini/commands` directory work from the composer. T3 Code also
reads `.agents/commands` from the active home and trusted project. Project definitions override
user definitions; `.gemini/commands` overrides `.agents/commands` at the same level. Nested paths
use Gemini's colon naming convention, such as `/git:commit`.

The command picker uses commands advertised by the running CLI alongside local TOML commands.
Use `{{args}}` or `$@` for all arguments, or `$1`, `$2`, and so on for individual arguments;
quoted arguments stay together. Commands without placeholders receive the full invocation at the
end. Both `@{path}` and bare `@path` add file references, which Gemini resolves using its own
ignore rules and access checks.

In a trusted Full Access session on macOS or Linux, `!{command}` inserts local shell output
before the prompt is sent. A failed command, excessive output, or a five-second timeout stops
submission. Check the command before explicitly retrying; T3 Code does not ask the agent to repeat
an attempted command. Sessions requiring approvals, sandboxing, custom policies, or active extensions,
and Windows sessions, use Gemini's shell tool directly. Templates combining argument placeholders with nested shell syntax also use the
tool.

Skills and TOML commands from enabled installed or linked Gemini extensions also appear in the
picker. Extension commands use an explicit prefix, such as `/reviewer:review`, so project commands
keep their names. Workspace extension enablement and the instance's `--extensions` selection apply.
Model configuration controls advertised by the running CLI update as the session changes.

Sending a follow-up while Gemini is working cancels and drains the current native prompt before
continuing the same T3 turn. Stop also waits for cancellation before another turn can start.

Structured question forms, provider-side conversation rollback, and manual context compaction
are not currently integrated for Gemini. File checkpoint restoration does not rewind
Gemini's conversation history.

## Workflows

T3 Code workflow scripts are provider-neutral. Choose a Gemini provider instance and model when
starting a scripted workflow; every prompt uses the same Gemini ACP session and has the same MCP,
skill, command, and permission behavior as a normal thread.

## Temporary Capacity Failures

Gemini can occasionally reject a prompt because the selected model has no available capacity. T3
Code briefly retries these capacity failures before reporting them. If Gemini remains unavailable,
wait a moment and try again or temporarily select another model.

## Usage And Quotas

Open **Usage** to see saved Gemini CLI token history and estimated API-equivalent costs, including
work outside T3 Code in the same Gemini home. These estimates are not your company's subscription bill.

**Usage → Limits** shows remaining model quotas and reset times for Google sign-in / Gemini Code Assist.
You can also use `/usage-limits` in a Gemini thread. Company accounts may need `GOOGLE_CLOUD_PROJECT`
in the instance's environment settings. T3 reads the existing CLI login without opening sign-in.
Quota reporting currently requires file-based Google credentials; API-key, Vertex AI, encrypted
credential storage, and custom Code Assist endpoints are unsupported. Token history remains available
for these setups when the CLI saves token metadata.
