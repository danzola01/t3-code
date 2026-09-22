import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { readGeminiDiscoverySettings, readGeminiSelectedAuthMethod } from "./GeminiHome.ts";
import { discoverGeminiCatalog, expandGeminiCustomCommand } from "./GeminiCatalog.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-settings-test-" });
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const write = (file: string, contents: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, file), contents)));
  yield* fs.makeDirectory(cwd);
  const environment = {
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, "system.json"),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(root, "defaults.json"),
  };
  return { fs, path, root, home, cwd, write, environment };
});

it.layer(NodeServices.layer)("Gemini settings compatibility", (it) => {
  it.effect(
    "preserves commented authentication and merges disabled skills across trusted settings",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(
          "home/.gemini/settings.json",
          '{\n// Google sign-in\n"security":{"auth":{"selectedType":"oauth-personal"}},"skills":{"disabled":["user"]}}',
        );
        yield* f.write("defaults.json", '{"skills":{"disabled":["default"]}}');
        yield* f.write("project/.gemini/settings.json", '{"skills":{"disabled":["project"]}}');
        yield* f.write("system.json", '{"skills":{"enabled":false,"disabled":["system"]}}');
        yield* f.write("home/.gemini/trustedFolders.json", encodeJson({ [f.cwd]: "TRUST_FOLDER" }));
        assert.equal(
          yield* readGeminiSelectedAuthMethod({ homePath: f.home }, f.environment, f.cwd),
          "oauth-personal",
        );
        const settings = yield* readGeminiDiscoverySettings(
          { homePath: f.home },
          f.environment,
          f.cwd,
        );
        assert.isFalse(settings.skillsEnabled);
        assert.sameMembers([...settings.disabledSkills], ["default", "user", "project", "system"]);
      }),
  );

  it.effect(
    "ignores workspace auth, skills and commands when untrusted, including explicit restrictions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(
          "home/.gemini/settings.json",
          '{"security":{"auth":{"selectedType":"oauth-personal"}}}',
        );
        yield* f.write(
          "project/.gemini/settings.json",
          '{"security":{"auth":{"selectedType":"vertex-ai"}}}',
        );
        yield* f.write("project/.gemini/commands/review.toml", 'prompt = "Review"');
        yield* f.write("project/.agents/skills/review/SKILL.md", "---\nname: review\n---\n");
        for (const environment of [
          f.environment,
          { ...f.environment, GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_RESTRICTED_MODE: "true" },
        ]) {
          assert.equal(
            yield* readGeminiSelectedAuthMethod({ homePath: f.home }, environment, f.cwd),
            "oauth-personal",
          );
          const catalog = yield* discoverGeminiCatalog({ homePath: f.home }, f.cwd, environment);
          assert.isEmpty(catalog.skills);
          assert.isFalse(catalog.slashCommands.some((command) => command.name === "review"));
        }
      }),
  );

  it.effect(
    "discovers .agents skills with native precedence and respects commented project disablement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const directory of [
          "home/.gemini",
          "home/.agents",
          "project/.gemini",
          "project/.agents",
        ]) {
          yield* f.write(
            `${directory}/skills/review/SKILL.md`,
            `---\nname: review\ndescription: ${directory}\n---\n`,
          );
        }
        yield* f.write(
          "project/.gemini/settings.json",
          '{\n/* policy */ "skills":{"disabled":["review"]}}',
        );
        const environment = { ...f.environment, GEMINI_CLI_TRUST_WORKSPACE: "true" };
        const catalog = yield* discoverGeminiCatalog({ homePath: f.home }, f.cwd, environment);
        assert.lengthOf(catalog.skills, 1);
        assert.deepInclude(catalog.skills[0], {
          name: "review",
          description: "project/.agents",
          enabled: false,
        });
      }),
  );

  it.effect(
    "delegates ignored files, symlinks and directories to native resource resolution without reading them",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("project/.geminiignore", "excluded.txt\n");
        yield* f.write("project/excluded.txt", "IGNORED_MARKER");
        yield* f.write("outside.txt", "OUTSIDE_MARKER");
        yield* f.fs.symlink(f.path.join(f.root, "outside.txt"), f.path.join(f.cwd, "link.txt"));
        yield* f.write(
          "home/.gemini/commands/review.toml",
          'prompt = "Review @{excluded.txt} @{link.txt} @{folder with spaces}"',
        );
        const expanded = yield* expandGeminiCustomCommand(
          { homePath: f.home },
          f.cwd,
          "/review",
          f.environment,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            readFileString: (file, options) => {
              assert.notInclude(
                [f.path.join(f.cwd, "excluded.txt"), f.path.join(f.cwd, "link.txt")],
                file,
              );
              return f.fs.readFileString(file, options);
            },
          }),
        );
        assert.notInclude(expanded.text, "MARKER");
        assert.deepEqual(
          expanded.resources,
          ["excluded.txt", "link.txt", "folder with spaces"].map((name) => ({
            type: "resource_link",
            name,
            uri: `file://${f.path.join(f.cwd, name)}`,
          })),
        );
      }),
  );
});
