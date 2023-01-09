import {
  formatFiles,
  installPackagesTask,
  readProjectConfiguration,
  Tree,
  updateJson,
  updateProjectConfiguration,
} from "@nrwl/devkit";
import { classify } from "@nrwl/workspace/src/utils/strings";
import libraryGenerator from "@nrwl/workspace/src/generators/library/library";
import { CommandGeneratorSchema } from "./schema";

export default async function (tree: Tree, options: CommandGeneratorSchema) {
  await libraryGenerator(tree, {
    name: options.name,
    directory: "libs/commands",
    unitTestRunner: "none",
  });

  await libraryGenerator(tree, {
    name: options.name,
    directory: "packages/legacy-structure/commands",
    unitTestRunner: "jest",
  });

  const config = readProjectConfiguration(tree, `legacy-structure-commands-${options.name}`);
  const sourceRoot = config.sourceRoot.replace("/src", "");
  updateProjectConfiguration(tree, `legacy-structure-commands-${options.name}`, {
    ...config,
    sourceRoot,
    projectType: "application",
    targets: {
      build: {
        dependsOn: ["compile"],
        executor: "nx:run-commands",
        options: {
          cwd: `${sourceRoot}/dist`,
          parallel: false,
          commands: ["rm -rf package.json"],
        },
      },
      compile: {
        executor: "@nrwl/esbuild:esbuild",
        outputs: ["{options.outputPath}"],
        options: {
          outputPath: `${sourceRoot}/dist`,
          main: `${sourceRoot}/src/index.ts`,
          tsConfig: `${sourceRoot}/tsconfig.lib.json`,
          assets: [
            {
              input: `libs/commands/${options.name}`,
              glob: "README.md",
              output: "../",
            },
          ],
          thirdParty: false,
          platform: "node",
          format: ["cjs"],
          additionalEntryPoints: [`${sourceRoot}/src/command.ts`],
          esbuildOptions: {
            external: ["*package.json"],
            outExtension: {
              ".js": ".js",
            },
          },
        },
      },
      ...config.targets,
    },
  });

  // Copy old package.json over and modify it
  tree.rename(`commands/${options.name}/package.json`, `${sourceRoot}/package.json`);
  updateJson(tree, `${sourceRoot}/package.json`, (packageJson) => {
    delete packageJson.scripts;
    return {
      ...packageJson,
      files: ["dist", "README.md", "CHANGELOG.md"],
      exports: {
        ".": {
          import: "./dist/index.js",
          require: "./dist/index.js",
        },
        "./command": {
          import: "./dist/command.js",
          require: "./dist/command.js",
        },
      },
      main: "./dist/index.js",
      repository: {
        ...packageJson.repository,
        directory: `packages/legacy-structure/commands/${options.name}`,
      },
    };
  });

  // Copy old README.md over
  tree.rename(`commands/${options.name}/README.md`, `libs/commands/${options.name}/README.md`);

  // Copy old CHANGELOG.md over
  tree.rename(`commands/${options.name}/CHANGELOG.md`, `${sourceRoot}/CHANGELOG.md`);

  // Create .gitignore file for the legacy structure library
  tree.write(
    `${sourceRoot}/.gitignore`,
    `# We intentionally ignore changes to the README.md in this library because it is generated by
# the compile target in project.json by copying the README.md from the relevant library.
# This is done to ensure that the README.md in that library is the source of truth.
README.md
`
  );

  // Finalize tsconfig.base.json updates
  updateJson(tree, "tsconfig.base.json", (tsconfig) => {
    const paths = tsconfig.compilerOptions.paths;
    paths[`@lerna/commands/${options.name}/*`] = [`libs/commands/${options.name}/src/*`];

    Object.keys(paths).forEach((key) => {
      if (key.includes("legacy")) {
        delete paths[key];
      }
    });

    return {
      ...tsconfig,
      compilerOptions: {
        ...tsconfig.compilerOptions,
        paths,
      },
    };
  });

  // Remove unneeded files
  tree.delete(`libs/commands/${options.name}/src/lib/commands-${options.name}.ts`);
  tree.delete(`${sourceRoot}/src/lib/legacy-structure-commands-${options.name}.ts`);
  tree.delete(`${sourceRoot}/README.md`);

  // Create legacy exports
  tree.write(
    `${sourceRoot}/src/index.ts`,
    `// eslint-disable-next-line @typescript-eslint/no-var-requires
const index = require("@lerna/commands/${options.name}");

module.exports = index;
module.exports.${classify(options.name)}Command = index.${classify(options.name)}Command;
`
  );
  tree.write(
    `${sourceRoot}/src/command.ts`,
    `// eslint-disable-next-line @typescript-eslint/no-var-requires
const command = require("@lerna/commands/${options.name}/command");

module.exports = command;    
`
  );

  // Update the relevant e2e project's implicit dependencies
  const e2eConfig = readProjectConfiguration(tree, `e2e-${options.name}`);
  updateProjectConfiguration(tree, `e2e-${options.name}`, {
    ...e2eConfig,
    implicitDependencies: e2eConfig.implicitDependencies.map((dep) => {
      if (dep === options.name) {
        return `commands-${options.name}`;
      }
      return dep;
    }),
  });

  tree.rename(`commands/${options.name}/index.js`, `libs/commands/${options.name}/src/index.ts`);
  tree.rename(`commands/${options.name}/command.js`, `libs/commands/${options.name}/src/command.ts`);

  // Add node types to legacy structure package
  updateJson(tree, `${sourceRoot}/tsconfig.lib.json`, (tsconfig) => {
    return {
      ...tsconfig,
      compilerOptions: {
        ...tsconfig.compilerOptions,
        types: ["node"],
      },
    };
  });

  // Copy and configure legacy tests
  tree.rename(`commands/${options.name}/__tests__`, `${sourceRoot}/__tests__`);
  updateJson(tree, `${sourceRoot}/tsconfig.spec.json`, (tsconfig) => {
    return {
      ...tsconfig,
      include: [...tsconfig.include, "__tests__/**/*.ts"],
    };
  });

  // Remove the command from the deps of the lerna package
  updateJson(tree, `packages/lerna/package.json`, (packageJson) => {
    const deps = packageJson.dependencies;
    delete deps[`@lerna/${options.name}`];
    return packageJson;
  });

  await formatFiles(tree);

  return installPackagesTask(tree, true);
}
