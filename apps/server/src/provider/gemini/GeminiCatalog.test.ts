// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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

      const commands = yield* discoverGeminiCustomCommands({ homePath: home }, workspace);
      assert.deepEqual(
        commands.map((command) => [command.name, command.description, command.scope]),
        [
          ["git:commit", "Custom command from commit.toml", "project"],
          ["review", "Project review", "project"],
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

  it.effect("expands arguments and file context while routing shell injections through tools", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gemini-expand-" });
      const home = path.join(root, "gemini-home");
      const workspace = path.join(root, "workspace");
      yield* writeFile(path.join(workspace, "notes.txt"), "important context");
      yield* writeFile(
        path.join(home, ".gemini", "commands", "inspect.toml"),
        [
          'description = "Inspect context"',
          "prompt = \"Inspect {{args}} with @{notes.txt}. Match: !{printf '%s' {{args}}}\"",
          "",
        ].join("\n"),
      );

      const expanded = yield* expandGeminiCustomCommand(
        { homePath: home },
        workspace,
        "/inspect carefully",
      );
      assert.include(expanded, "Inspect carefully with important context");
      assert.include(expanded, "<gemini-custom-command-shell-injection>");
      assert.include(expanded, "printf '%s' 'carefully'");
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
