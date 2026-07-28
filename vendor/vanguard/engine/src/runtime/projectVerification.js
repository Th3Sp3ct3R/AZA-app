import { access, readFile } from "node:fs/promises";
import path from "node:path";
export async function detectProjectVerification(workspace) {
    const root = path.resolve(workspace);
    try {
        const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
        if (typeof parsed.scripts?.test === "string")
            return { command: "npm", args: ["test"] };
        if (typeof parsed.scripts?.check === "string")
            return { command: "npm", args: ["run", "check"] };
        if (typeof parsed.scripts?.build === "string")
            return { command: "npm", args: ["run", "build"] };
    }
    catch { }
    if (await exists(path.join(root, "gradle", "wrapper", "gradle-wrapper.jar"))) {
        return {
            command: "java",
            args: [
                "-classpath",
                path.join("gradle", "wrapper", "gradle-wrapper.jar"),
                "org.gradle.wrapper.GradleWrapperMain",
                "build",
                "--no-daemon",
            ],
        };
    }
    if (await exists(path.join(root, "pyproject.toml")) || await exists(path.join(root, "pytest.ini"))) {
        return { command: "python", args: ["-m", "pytest"] };
    }
    if (await exists(path.join(root, "Cargo.toml")))
        return { command: "cargo", args: ["test"] };
    if (await exists(path.join(root, "pom.xml")))
        return { command: "mvn", args: ["test"] };
    return undefined;
}
async function exists(file) {
    try {
        await access(file);
        return true;
    }
    catch {
        return false;
    }
}
