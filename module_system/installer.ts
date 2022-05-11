/*
Copyright 2022 New Vector Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as fs from "fs";
import * as child_process from "child_process";
import * as semver from "semver";

import { BuildConfig } from "./BuildConfig";

// This expects to be run from ./scripts/install.ts

const moduleApiDepName = "@matrix-org/react-sdk-module-api";

const MODULES_TS_HEADER = `
/*
 * THIS FILE IS AUTO-GENERATED
 * You can edit it you like, but your changes will be overwritten,
 * so you'd just be trying to swim upstream like a salmon.
 * You are not a salmon.
 */

import { RuntimeModule } from "@matrix-org/react-sdk-module-api/lib/RuntimeModule";
`;
const MODULES_TS_DEFINITIONS = `
export const INSTALLED_MODULES: RuntimeModule[] = [];
`;

export function installer(config: BuildConfig): void {
    if (!config.modules?.length) {
        // nothing to do
        writeModulesTs(MODULES_TS_HEADER + MODULES_TS_DEFINITIONS);
        return;
    }

    let exitCode = 0;

    // We cheat a bit and store the current package.json and lockfile so we can safely
    // run `yarn add` without creating extra committed files for people. We restore
    // these files by simply overwriting them when we're done.
    const packageDeps = readCurrentPackageDetails();

    // Record which optional dependencies there are currently, if any, so we can exclude
    // them from our "must be a module" assumption later on.
    const currentOptDeps = getOptionalDepNames(packageDeps.packageJson);

    try {
        // Install the modules with yarn
        for (const ref of config.modules) {
            callYarnAdd(ref);
        }

        // Grab the optional dependencies again and exclude what was there already. Everything
        // else must be a module, we assume.
        const pkgJsonStr = fs.readFileSync("./package.json", "utf-8");
        const optionalDepNames = getOptionalDepNames(pkgJsonStr);
        const installedModules = optionalDepNames.filter(d => !currentOptDeps.includes(d));

        // Ensure all the modules are compatible. We check them all and report at the end to
        // try and save the user some time debugging this sort of failure.
        const ourApiVersion = findDepVersionInPackageJson(moduleApiDepName, pkgJsonStr);
        const incompatibleNames: string[] = [];
        for (const moduleName of installedModules) {
            const modApiVersion = getModuleApiVersionFor(moduleName);
            if (!isModuleVersionCompatible(ourApiVersion, modApiVersion)) {
                incompatibleNames.push(moduleName);
            }
        }
        if (incompatibleNames.length > 0) {
            console.error(
                "The following modules are not compatible with this version of element-web. Please update the module " +
                "references and try again.",
                JSON.stringify(incompatibleNames, null, 4), // stringify to get prettier/complete output
            );
            exitCode = 1;
            return; // hit the finally{} block before exiting
        }

        // If we reach here, everything seems fine. Write modules.ts and log some output
        // Note: we compile modules.ts in two parts for developer friendliness if they
        // happen to look at it.
        console.log("The following modules have been installed: ", installedModules);
        let modulesTsHeader = MODULES_TS_HEADER;
        let modulesTsDefs = MODULES_TS_DEFINITIONS;
        let index = 0;
        for (const moduleName of installedModules) {
            const importName = `Module${++index}`;
            modulesTsHeader += `import ${importName} from "${moduleName}";\n`;
            modulesTsDefs += `INSTALLED_MODULES.push(${importName});\n`;
        }
        writeModulesTs(modulesTsHeader + modulesTsDefs);
        console.log("Done installing modules");
    } finally {
        // Always restore package details (or at least try to)
        writePackageDetails(packageDeps);

        if (exitCode > 0) {
            process.exit(exitCode);
        }
    }
}

type RawDependencies = {
    lockfile: string;
    packageJson: string;
};

function readCurrentPackageDetails(): RawDependencies {
    return {
        lockfile: fs.readFileSync("./yarn.lock", "utf-8"),
        packageJson: fs.readFileSync("./package.json", "utf-8"),
    };
}

function writePackageDetails(deps: RawDependencies) {
    fs.writeFileSync("./yarn.lock", deps.lockfile, "utf-8");
    fs.writeFileSync("./package.json", deps.packageJson, "utf-8");
}

function callYarnAdd(dep: string) {
    // Add the module to the optional dependencies section just in case something
    // goes wrong in restoring the original package details.
    child_process.execSync(`yarn add -O ${dep}`, {
        env: process.env,
        stdio: ['inherit', 'inherit', 'inherit'],
    });
}

function getOptionalDepNames(pkgJsonStr: string): string[] {
    return Object.keys(JSON.parse(pkgJsonStr)?.['optionalDependencies'] ?? {});
}

function findDepVersionInPackageJson(dep: string, pkgJsonStr: string): string {
    const pkgJson = JSON.parse(pkgJsonStr);
    const packages = {
        ...(pkgJson['optionalDependencies'] ?? {}),
        ...(pkgJson['devDependencies'] ?? {}),
        ...(pkgJson['dependencies'] ?? {}),
    };
    return packages[dep];
}

function getModuleApiVersionFor(moduleName: string): string {
    // We'll just pretend that this isn't highly problematic...
    // Yarn is fairly stable in putting modules in a flat hierarchy, at least.
    const pkgJsonStr = fs.readFileSync(`./node_modules/${moduleName}/package.json`, "utf-8");
    return findDepVersionInPackageJson(moduleApiDepName, pkgJsonStr);
}

function isModuleVersionCompatible(ourApiVersion: string, moduleApiVersion: string): boolean {
    if (!moduleApiVersion) return false;
    return semver.satisfies(moduleApiVersion, ourApiVersion);
}

function writeModulesTs(content: string) {
    fs.writeFileSync("./src/modules.ts", content, "utf-8");
}
