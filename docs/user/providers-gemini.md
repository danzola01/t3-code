# Gemini CLI

T3 Code can run Gemini CLI as a provider through Gemini's Agent Client Protocol (ACP) mode. The
Gemini provider supports conversations, streamed responses and reasoning, tool approvals, images,
model switching, session resume and cancellation, MCP servers, skills, custom commands, and T3 Code
workflow scripts.

## Before You Add The Provider

Install Gemini CLI on the machine running the T3 Code environment, then start `gemini` once in a
terminal and complete your company's approved sign-in flow. T3 Code uses Gemini CLI's existing
credentials; it does not ask for or store a Google credential itself.

In T3 Code, open Settings, add a provider, and choose **Gemini**. The default binary path is
`gemini`.

The **ACP authentication method** can normally stay empty. T3 Code first respects the authentication
method saved by Gemini CLI, then considers Gemini's authentication environment variables, and falls
back to an advertised method. Set the field explicitly when an administrator requires one of
`oauth-personal`, `gemini-api-key`, `vertex-ai`, or `gateway`.

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
CLI before starting the thread. You can add `--skip-trust` under **Launch arguments**, but doing so
explicitly disables that protection for the instance.

T3 Code maps Gemini ACP tool permission requests into the same approval UI used by other providers.
Full Access automatically selects an allow option when Gemini offers one; other modes continue to
show the request.

## MCP

Gemini's own MCP configuration continues to work normally. T3 Code also attaches its per-thread MCP
server over ACP, so Gemini can use T3 Code tools without writing credentials or endpoints into the
project.

Gemini MCP activity rows show the server, tool arguments, and a compact result preview. Large MCP
responses stay summarized when a thread is sent to another client.

When Gemini publishes a new topic with its built-in `update_topic` tool, T3 Code renames the thread
to that topic so the sidebar stays aligned with Gemini's current work.

## Skills And Custom Commands

Gemini skills are discovered from the active Gemini home and from `.gemini/skills` in the project.
Disabled skills in Gemini's `settings.json` stay disabled. Selecting a skill from T3 Code asks
Gemini to load it through the `activate_skill` tool.

TOML commands under `$GEMINI_CLI_HOME/.gemini/commands` (or `~/.gemini/commands` when no custom
home is set) and the project's `.gemini/commands` directory work from the composer. Project
definitions override user definitions, and nested paths use Gemini's colon naming convention, such
as `/git:commit`.

The command bridge supports `{{args}}`, default raw-invocation appending, and `@{path}` project-file
injection. A `!{command}` block is routed through Gemini's shell tool so it still uses the thread's
T3 Code approval policy instead of executing outside the agent boundary.

## Workflows

T3 Code workflow scripts are provider-neutral. Choose a Gemini provider instance and model when
starting a scripted workflow; every prompt uses the same Gemini ACP session and has the same MCP,
skill, command, and permission behavior as a normal thread.

## Temporary Capacity Failures

Gemini can occasionally reject a prompt because the selected model has no available capacity. T3
Code briefly retries these capacity failures before reporting them. If Gemini remains unavailable,
wait a moment and try again or temporarily select another model.
