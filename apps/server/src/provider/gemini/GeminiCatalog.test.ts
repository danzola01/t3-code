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
