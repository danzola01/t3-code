// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  discoverGeminiCatalog,
  discoverGeminiCustomCommands,
  expandGeminiCustomCommand,
  expandGeminiSkillMentions,
} from "./GeminiCatalog.ts";
import { readGeminiSelectedAuthMethod } from "./GeminiHome.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("GeminiCatalog", (it) => {
  it.effect("discovers the four linked Ping skills alongside regular user skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gemini-linked-skill-" });
      const home = path.join(root, "gemini-home");
      const skillsDirectory = path.join(home, ".gemini", "skills");
      const regularNames = [
        "ciam-security-reviewer",
        "format-security-findings",
        "hallmark",
        "handoff",
        "teach",
        "unslop",
        "writing-for-agents",
      ];
      const linkedNames = [
        "ping-app-integration",
        "ping-foundation",
        "ping-quickstart",
        "ping-universal-services",
      ];
      for (const name of regularNames) {
        yield* writeFile(
          path.join(skillsDirectory, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Regular skill.\n---\n`,
        );
      }
      for (const name of linkedNames) {
        const source = path.join(root, "external", name);
        yield* writeFile(
          path.join(source, "SKILL.md"),
          `---\nname: ${name}\ndescription: Linked skill.\n---\n`,
        );
        yield* fileSystem.symlink(
          path.relative(skillsDirectory, source),
          path.join(skillsDirectory, name),
        );
      }
      yield* writeFile(
        path.join(root, "external", "ping-foundation", "references", "example", "SKILL.md"),
        "---\nname: example\ndescription: A bundled example, not an installed skill.\n---\n",
      );
      yield* fileSystem.symlink(path.join(root, "missing"), path.join(skillsDirectory, "broken"));

      // Exercise recursive listings that include symlinks without descending into
      // them, even on hosts where the default string listing follows links.
      const catalog = yield* discoverGeminiCatalog({ homePath: home }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readDirectory: (directory, options) =>
            options?.recursive
              ? Effect.tryPromise(() =>
                  NodeFSP.readdir(directory, { recursive: true, withFileTypes: true }),
                ).pipe(
                  Effect.map((entries) =>
                    entries.map((entry) =>
                      path.relative(directory, path.join(entry.parentPath, entry.name)),
                    ),
                  ),
                  Effect.catch(() => fileSystem.readDirectory(directory, options)),
                )
              : fileSystem.readDirectory(directory, options),
        }),
      );
      assert.deepEqual(
        catalog.skills.map((skill) => skill.name),
        [...regularNames, ...linkedNames].sort(),
      );
      const expanded = yield* expandGeminiSkillMentions(
        { homePath: home },
        path.join(root, "workspace"),
        "$ping-foundation set up SSO",
      );
      assert.include(
        expanded,
        "Activate these Gemini CLI skills with the activate_skill tool before proceeding: ping-foundation",
      );

      yield* writeFile(
        path.join(home, ".gemini", "settings.json"),
        encodeUnknownJson({ skills: { disabled: ["ping-foundation"] } }),
      );
      const disabledCatalog = yield* discoverGeminiCatalog({ homePath: home });
      assert.strictEqual(
        disabledCatalog.skills.find((skill) => skill.name === "ping-foundation")?.enabled,
        false,
      );
      const input = "$ping-foundation set up SSO";
      assert.strictEqual(
        yield* expandGeminiSkillMentions({ homePath: home }, path.join(root, "workspace"), input),
        input,
      );
      yield* fileSystem.remove(path.join(skillsDirectory, "ping-foundation"));
      const unlinkedCatalog = yield* discoverGeminiCatalog({ homePath: home });
      assert.isFalse(unlinkedCatalog.skills.some((skill) => skill.name === "ping-foundation"));
    }),
  );

  it.effect("discovers linked skills even when their asset directories cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-gemini-linked-assets-",
      });
      const home = path.join(root, "gemini-home");
      const source = path.join(root, "skill-source");
      const assets = path.join(source, "assets");
      const skillsDirectory = path.join(home, ".gemini", "skills");
      yield* writeFile(
        path.join(source, "SKILL.md"),
        "---\nname: linked-review\ndescription: Review linked code.\n---\n",
      );
      yield* fileSystem.makeDirectory(assets);
      yield* fileSystem.makeDirectory(skillsDirectory, { recursive: true });
      yield* fileSystem.symlink(source, path.join(skillsDirectory, "linked-review"));
      yield* fileSystem.chmod(assets, 0o000);

      const catalog = yield* discoverGeminiCatalog({ homePath: home }).pipe(
        Effect.ensuring(fileSystem.chmod(assets, 0o700).pipe(Effect.orDie)),
      );
      assert.deepEqual(
        catalog.skills.map((skill) => skill.name),
        ["linked-review"],
      );
    }),
  );

  it.effect("discovers user and project commands and skills with project precedence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gemini-catalog-" });
      const home = path.join(root, "gemini-home");
      const workspace = path.join(root, "workspace");
      yield* writeFile(
        path.join(home, ".gemini", "trustedFolders.json"),
        encodeUnknownJson({ [workspace]: "TRUST_FOLDER" }),
      );

      yield* writeFile(
        path.join(home, ".gemini", "commands", "review.toml"),
        'description = "User review"\nprompt = "Review from user: {{args}}"\n',
      );
      yield* writeFile(
        path.join(workspace, ".gemini", "commands", "review.toml"),
        'description = "Project review"\nprompt = "Review from project: {{args}}"\n',
      );
      yield* writeFile(
        path.join(workspace, ".gemini", "commands", "git", "commit.toml"),
        'prompt = "Create a commit message"\n',
      );
      yield* writeFile(
        path.join(home, ".gemini", "skills", "release", "SKILL.md"),
        "---\nname: release\ndescription: Prepare a release.\n---\n",
      );
      yield* writeFile(
        path.join(workspace, ".gemini", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy this project.\n---\n",
      );
      yield* writeFile(
        path.join(home, ".gemini", "settings.json"),
        encodeUnknownJson({
          security: { auth: { selectedType: "vertex-ai" } },
          skills: { enabled: true, disabled: ["release"] },
        }),
      );

      yield* writeFile(
        path.join(home, ".agents", "commands", "shared.toml"),
        'prompt = "User shared"',
      );
      yield* writeFile(
        path.join(workspace, ".agents", "commands", "shared.toml"),
        'prompt = "Project shared"',
      );
      const commands = yield* discoverGeminiCustomCommands({ homePath: home }, workspace);
      assert.deepEqual(
        commands.map((command) => [command.name, command.description, command.scope]),
        [
          ["git:commit", "Custom command from commit.toml", "project"],
          ["review", "Project review", "project"],
          ["shared", "Custom command from shared.toml", "project"],
        ],
      );

      const catalog = yield* discoverGeminiCatalog({ homePath: home }, workspace);
      assert.includeMembers(
        catalog.slashCommands.map((command) => command.name),
        ["help", "memory", "git:commit", "review"],
      );
      assert.deepEqual(
        catalog.skills.map((skill) => [skill.name, skill.scope, skill.enabled]),
        [
          ["deploy", "project", true],
          ["release", "user", false],
        ],
      );
      assert.strictEqual(yield* readGeminiSelectedAuthMethod({ homePath: home }), "vertex-ai");
    }),
  );

  it.effect(
    "discovers enabled linked-extension skills and namespaced commands without overriding project definitions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-extensions-" });
        const home = path.join(root, "home");
        const cwd = path.join(root, "project");
        const source = path.join(root, "linked");
        yield* writeFile(
          path.join(home, ".gemini", "trustedFolders.json"),
          encodeUnknownJson({ [cwd]: "TRUST_FOLDER" }),
        );
        yield* writeFile(
          path.join(home, ".gemini", "extensions", "reviewer", ".gemini-extension-install.json"),
          encodeUnknownJson({ type: "link", source }),
        );
        yield* writeFile(
          path.join(source, "gemini-extension.json"),
          encodeUnknownJson({ name: "reviewer", version: "1.0.0" }),
        );
        yield* writeFile(
          path.join(source, "skills", "review", "SKILL.md"),
          "---\nname: review\ndescription: Extension review\n---\n",
        );
        yield* writeFile(
          path.join(source, "commands", "review.toml"),
          'prompt = "Extension {{args}}"',
        );
        yield* writeFile(
          path.join(cwd, ".gemini", "commands", "review.toml"),
          'prompt = "Project {{args}}"',
        );
        const config = { homePath: home };
        const catalog = yield* discoverGeminiCatalog(config, cwd);
        assert.isTrue(
          catalog.skills.some((skill) => skill.name === "review" && skill.scope === "extension"),
        );
        assert.includeMembers(
          catalog.slashCommands.map((command) => command.name),
          ["review", "reviewer:review"],
        );
        assert.equal(
          (yield* expandGeminiCustomCommand(config, cwd, "/reviewer:review changes")).text,
          "Extension changes",
        );
        yield* writeFile(
          path.join(home, ".gemini", "extensions", "extension-enablement.json"),
          encodeUnknownJson({ reviewer: { overrides: ["!*"] } }),
        );
        assert.isEmpty((yield* discoverGeminiCatalog(config, cwd)).skills);
        assert.isFalse(
          (yield* discoverGeminiCatalog(config, cwd)).slashCommands.some(
            (command) => command.name === "reviewer:review",
          ),
        );
        const selected = yield* discoverGeminiCatalog(
          { ...config, launchArgs: "--extensions reviewer" },
          cwd,
        );
        assert.isTrue(selected.skills.some((skill) => skill.name === "review"));
        assert.isEmpty(
          (yield* discoverGeminiCatalog({ ...config, launchArgs: "-e none" }, cwd)).skills,
        );
        assert.isEmpty(
          (yield* discoverGeminiCatalog(config, cwd, { GEMINI_RESTRICTED_MODE: "true" })).skills,
        );
      }),
  );

  it.effect("expands quoted positional arguments, file links, and local shell output", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gemini-expand-" });
      const home = path.join(root, "gemini-home");
      const workspace = path.join(root, "workspace");
      yield* writeFile(
        path.join(home, ".gemini", "trustedFolders.json"),
        encodeUnknownJson({ [workspace]: "TRUST_FOLDER" }),
      );
      yield* writeFile(path.join(workspace, "notes.txt"), "important context");
      yield* writeFile(
        path.join(home, ".gemini", "commands", "inspect.toml"),
        [
          'description = "Inspect context"',
          "prompt = \"Inspect $1 / $2 / $3 with @{notes.txt} and @src/file.ts. Match: !{printf '%s' $2}\"",
          "",
        ].join("\n"),
      );

      const expanded = yield* expandGeminiCustomCommand(
        { homePath: home },
        workspace,
        ' /inspect "very carefully" "$(touch injected)"',
        { TEST_GEMINI: "yes" },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
      assert.include(
        expanded.text,
        "Inspect very carefully / $(touch injected) /  with @notes.txt",
      );
      assert.notInclude(expanded.text, "important context");
      assert.deepEqual(expanded.resources, [
        {
          type: "resource_link",
          name: "notes.txt",
          uri: `file://${path.join(workspace, "notes.txt")}`,
        },
        {
          type: "resource_link",
          name: "src/file.ts",
          uri: `file://${path.join(workspace, "src/file.ts")}`,
        },
      ]);
      assert.include(expanded.text, "Match: $(touch injected)");
      assert.isFalse(yield* fileSystem.exists(path.join(workspace, "injected")));
      const restricted = yield* expandGeminiCustomCommand(
        { homePath: home },
        workspace,
        "/inspect test",
      );
      assert.include(restricted.text, "<gemini-custom-command-shell-injection>");
      for (const config of [
        { sandbox: true },
        { policyPath: "/rules.toml" },
        { launchArgs: "--policy=/rules.toml" },
      ]) {
        const guarded = yield* expandGeminiCustomCommand(
          { homePath: home, ...config },
          workspace,
          "/inspect test",
          {},
          { runtimeMode: "full-access", interactionMode: "default" },
        );
        assert.include(guarded.text, "<gemini-custom-command-shell-injection>");
      }
      for (const runtimePolicy of [
        { runtimeMode: "full-access", interactionMode: "plan" },
        { runtimeMode: "approval-required", interactionMode: "default" },
      ] as const) {
        const guarded = yield* expandGeminiCustomCommand(
          { homePath: home },
          workspace,
          "/inspect test",
          {},
          runtimePolicy,
        );
        assert.include(guarded.text, "<gemini-custom-command-shell-injection>");
      }
      for (const settings of [{ tools: { sandbox: true } }, { policyPaths: ["/rules.toml"] }]) {
        yield* writeFile(path.join(home, ".gemini", "settings.json"), encodeUnknownJson(settings));
        const guarded = yield* expandGeminiCustomCommand(
          { homePath: home },
          workspace,
          "/inspect test",
          {},
          { runtimeMode: "full-access", interactionMode: "default" },
        );
        assert.include(guarded.text, "<gemini-custom-command-shell-injection>");
      }
      yield* fileSystem.remove(path.join(home, ".gemini", "settings.json"));
      yield* writeFile(path.join(home, ".gemini", "policies", "rules.toml"), "");
      const policyGuarded = yield* expandGeminiCustomCommand(
        { homePath: home },
        workspace,
        "/inspect test",
        {},
        { runtimeMode: "full-access", interactionMode: "default" },
      );
      assert.include(policyGuarded.text, "<gemini-custom-command-shell-injection>");
      yield* fileSystem.remove(path.join(home, ".gemini", "policies"), { recursive: true });
      const windows = yield* expandGeminiCustomCommand(
        { homePath: home },
        workspace,
        "/inspect test",
        {},
        { runtimeMode: "full-access", interactionMode: "default" },
      ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      assert.include(windows.text, "<gemini-custom-command-shell-injection>");
      for (const prompt of [
        "!{echo hello}",
        "!{printf '%s' $@}",
        '!{printf "<%s>" "$@"}',
        "!{printf '%s' \\$1}",
        "!{printf '%s' {{args}}}",
        "!{printf '%s' $1}",
        "!{printf '%s' \"$1\"}",
        "!{printf \"%s\" '$1'}",
        "!{printf '%s' \"$TEST_GEMINI\"}",
        "!{pwd}",
      ]) {
        yield* writeFile(
          path.join(home, ".gemini", "commands", "shell.toml"),
          `prompt = '''${prompt}'''`,
        );
        const args = prompt.includes("$1") ? '"$(touch injected)"' : '"one two" three';
        const result = yield* expandGeminiCustomCommand(
          { homePath: home },
          workspace,
          `/shell ${args}`,
          { TEST_GEMINI: "from-environment" },
          { runtimeMode: "full-access", interactionMode: "default" },
        );
        if (prompt.includes("\\$1")) assert.equal(result.text, "$1");
        else if (prompt.includes("$1")) assert.include(result.text, "$(touch injected)");
        else if (prompt.includes('"$@"')) assert.equal(result.text, "<one two><three>");
        else if (prompt.includes("$@")) assert.equal(result.text, "one twothree");
        else if (prompt.includes("{{args}}")) assert.equal(result.text, args);
        else if (prompt.includes("TEST_GEMINI")) assert.include(result.text, "from-environment");
        else if (prompt.includes("pwd")) assert.include(result.text, workspace);
        else assert.include(result.text, "hello");
        assert.isFalse(yield* fileSystem.exists(path.join(workspace, "injected")));
      }
    }),
  );

  it.effect("interrupts timed-out shell expansion and reports failure without retrying", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gemini-timeout-" });
      yield* writeFile(
        path.join(root, ".gemini", "commands", "slow.toml"),
        'prompt = "!{long-running-command}"',
      );
      const spawned = yield* Deferred.make<void>();
      let stopped = false;
      const expanding = yield* expandGeminiCustomCommand(
        { homePath: root },
        root,
        "/slow",
        { GEMINI_CLI_TRUST_WORKSPACE: "true" },
        { runtimeMode: "full-access", interactionMode: "default" },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
          ...spawner,
          spawn: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  stopped = true;
                }),
              );
              yield* Deferred.succeed(spawned, undefined);
              return yield* Effect.never;
            }),
        }),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(spawned);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(expanding);
      assert.isTrue(stopped);
      assert.equal(result.reason, "timeout");
    }),
  );

  it.effect("stops after a shell failure without inviting a second execution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-command-failure-" });
      yield* writeFile(
        path.join(root, ".gemini", "commands", "fail.toml"),
        'prompt = "!{printf once >> marker; printf diagnostic >&2; exit 7}!{printf later > later}"',
      );
      const error = yield* expandGeminiCustomCommand(
        { homePath: root },
        root,
        "/fail",
        { GEMINI_CLI_TRUST_WORKSPACE: "true" },
        { runtimeMode: "full-access", interactionMode: "default" },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "GeminiCommandExpansionError");
      assert.equal(error.reason, "exit");
      assert.equal(error.exitCode, 7);
      assert.deepEqual(error.cause, { stderr: "diagnostic", truncated: false });
      assert.equal(yield* fs.readFileString(path.join(root, "marker")), "once");
      assert.isFalse(yield* fs.exists(path.join(root, "later")));
    }),
  );

  it.effect("turns composer skill mentions into an activate_skill instruction", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gemini-skill-" });
      const home = path.join(root, "gemini-home");
      const workspace = path.join(root, "workspace");
      yield* writeFile(
        path.join(home, ".gemini", "trustedFolders.json"),
        encodeUnknownJson({ [workspace]: "TRUST_FOLDER" }),
      );
      yield* writeFile(
        path.join(workspace, ".gemini", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy this project.\n---\n",
      );

      const expanded = yield* expandGeminiSkillMentions(
        { homePath: home },
        workspace,
        "$deploy ship the release",
      );
      assert.include(expanded, "activate_skill");
      assert.include(expanded, "deploy");
      assert.include(expanded, "$deploy ship the release");
    }),
  );
});
