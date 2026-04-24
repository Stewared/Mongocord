const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { jsonc } = require("jsonc");

const ENV_FILE_PATH = path.resolve(__dirname, "env.json");
const EXAMPLE_ENV_FILE_PATH = path.resolve(__dirname, "example.env.jsonc");
const ECOSYSTEM_FILE_PATH = path.resolve(__dirname, "ecosystem.config.js");
const PM2_APP_NAME = "mongocord";
const REQUIRED_FIELDS = [
    "token",
    "clientId",
    "mongoUri",
    "devAdmins"
];

function readJsoncFile(filePath) {
    try {
        return jsonc.parse(fs.readFileSync(filePath, "utf8"));
    }
    catch (error) {
        throw new Error(`Failed to read ${path.basename(filePath)}: ${error.message}`);
    }
}

function readExistingEnv() {
    if (!fs.existsSync(ENV_FILE_PATH)) {
        return {};
    }

    try {
        return jsonc.parse(fs.readFileSync(ENV_FILE_PATH, "utf8")) || {};
    }
    catch (error) {
        console.warn(`Could not parse existing env.json (${error.message}). Starting with blank values.`);
        return {};
    }
}

function validateEnvShape(env) {
    for (const field of REQUIRED_FIELDS) {
        if (!(field in env)) {
            throw new Error(`Missing required environment field "${field}" in env.json.`);
        }
    }

    if (!Array.isArray(env.devAdmins) || env.devAdmins.length === 0) {
        throw new Error("env.json field \"devAdmins\" must be a non-empty array of Discord user IDs.");
    }
}

function parseDevAdmins(value) {
    return [...new Set(
        String(value || "")
            .split(/[\s,]+/)
            .map(entry => entry.trim())
            .filter(Boolean)
    )];
}

async function askField(rl, label, {
    defaultValue = "",
    required = false,
    parser = value => value,
    hideDefault = false
} = {}) {
    while (true) {
        const hasDefault = defaultValue != null && String(defaultValue).length > 0;
        const suffix = hasDefault
            ? (hideDefault ? " [current set]" : ` [${String(defaultValue)}]`)
            : "";

        const answer = (await rl.question(`${label}${suffix}: `)).trim();
        const rawValue = answer || (hasDefault ? String(defaultValue) : "");
        const parsedValue = parser(rawValue);

        const isMissing = Array.isArray(parsedValue)
            ? parsedValue.length === 0
            : !String(parsedValue).trim();

        if (required && isMissing) {
            console.log(`"${label}" is required.`);
            continue;
        }

        return parsedValue;
    }
}

async function askYesNo(rl, prompt, defaultYes = false) {
    const suffix = defaultYes ? " [Y/n]" : " [y/N]";

    while (true) {
        const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();

        if (!answer) {
            return defaultYes;
        }

        if (["y", "yes"].includes(answer)) {
            return true;
        }

        if (["n", "no"].includes(answer)) {
            return false;
        }

        console.log("Please answer yes or no.");
    }
}

function runCommand(command, args, inheritOutput = true) {
    return spawnSync(command, args, {
        cwd: __dirname,
        shell: process.platform === "win32",
        stdio: inheritOutput ? "inherit" : "pipe",
        encoding: "utf8"
    });
}

function getLocalPm2Command() {
    return path.join(__dirname, "node_modules", ".bin", process.platform === "win32" ? "pm2.cmd" : "pm2");
}

function getPm2Command() {
    const globalResult = runCommand("pm2", ["-v"], false);
    if (globalResult.status === 0) {
        return "pm2";
    }

    const localCommand = getLocalPm2Command();
    if (!fs.existsSync(localCommand)) {
        return null;
    }

    const localResult = runCommand(localCommand, ["-v"], false);
    return localResult.status === 0 ? localCommand : null;
}

function hasPm2() {
    return Boolean(getPm2Command());
}

function commandExists(command) {
    const lookup = process.platform === "win32" ? "where" : "which";
    const result = runCommand(lookup, [command], false);
    return result.status === 0;
}

function getPm2StartupCommand() {
    if (commandExists("pm2-startup")) {
        return "pm2-startup";
    }

    if (process.platform !== "win32") {
        return null;
    }

    const appData = process.env.APPDATA;
    if (!appData) {
        return null;
    }

    const candidate = path.join(appData, "npm", "pm2-startup.cmd");
    if (fs.existsSync(candidate)) {
        return candidate;
    }

    return null;
}

function configurePm2StartupForBoot(pm2Command) {
    if (process.platform === "win32") {
        console.log("Windows detected. Configuring startup with pm2-windows-startup.");

        let startupCommand = getPm2StartupCommand();
        if (!startupCommand) {
            console.log("pm2-windows-startup is not installed. Installing it globally now...");
            const installHelperResult = runCommand("npm", ["install", "-g", "pm2-windows-startup"]);
            if (installHelperResult.status !== 0) {
                console.log("Could not install pm2-windows-startup automatically.");
                return false;
            }

            startupCommand = getPm2StartupCommand();
        }

        if (!startupCommand) {
            console.log("Could not locate pm2-startup after installation.");
            return false;
        }

        const startupResult = runCommand(startupCommand, ["install"]);
        if (startupResult.status !== 0) {
            console.log("pm2-startup install did not complete. Try running setup in an elevated shell.");
            return false;
        }

        return true;
    }

    const startupResult = runCommand(pm2Command, ["startup"]);
    if (startupResult.status !== 0) {
        console.log("pm2 startup did not complete. Try running it in an elevated shell.");
        return false;
    }

    return true;
}

function registerSlashCommands() {
    console.log("Registering Discord slash commands...");
    const result = runCommand("node", ["launchCommands.js"]);
    return result.status === 0;
}

async function installPm2(rl) {
    const installResult = runCommand("npm", ["install", "-g", "pm2"]);
    let pm2Command = getPm2Command();
    if (installResult.status === 0 && pm2Command) {
        return pm2Command;
    }

    if (process.platform !== "win32") {
        if (commandExists("sudo")) {
            const shouldInstallWithSudo = await askYesNo(
                rl,
                "Global install failed. Retry with sudo (will prompt for your password)",
                true
            );

            if (shouldInstallWithSudo) {
                const sudoInstallResult = runCommand("sudo", ["npm", "install", "-g", "pm2"]);
                pm2Command = getPm2Command();
                if (sudoInstallResult.status === 0 && pm2Command) {
                    return pm2Command;
                }
            }
        }

        const shouldInstallLocal = await askYesNo(
            rl,
            "Install PM2 locally in this project instead (no root required)",
            true
        );

        if (shouldInstallLocal) {
            const localInstallResult = runCommand("npm", ["install", "--no-save", "pm2"]);
            pm2Command = getPm2Command();
            if (localInstallResult.status === 0 && pm2Command) {
                console.log("PM2 installed locally. Use npm scripts or npx pm2 for future PM2 commands.");
                return pm2Command;
            }
        }
    }

    return null;
}

async function configurePm2(rl) {
    const summary = {
        usedPm2: false,
        available: false,
        started: false,
        startupEnabled: false
    };

    const wantsPm2 = await askYesNo(rl, "Configure PM2 now", true);
    if (!wantsPm2) {
        return summary;
    }

    summary.usedPm2 = true;
    let pm2Command = getPm2Command();

    if (!pm2Command) {
        console.log("PM2 was not found in PATH.");
        const shouldInstall = await askYesNo(rl, "Install PM2 globally with npm install -g pm2", true);

        if (!shouldInstall) {
            console.log("Skipping PM2 setup.");
            return summary;
        }

        pm2Command = await installPm2(rl);
        if (!pm2Command) {
            console.log("Could not install PM2 automatically. Install it manually and rerun setup if needed.");
            return summary;
        }
    }

    summary.available = true;

    const shouldStart = await askYesNo(rl, "Start or restart Mongocord in PM2 now", true);
    if (shouldStart) {
        let startResult = runCommand(pm2Command, ["startOrRestart", ECOSYSTEM_FILE_PATH, "--only", PM2_APP_NAME]);
        if (startResult.status !== 0) {
            startResult = runCommand(pm2Command, ["start", ECOSYSTEM_FILE_PATH, "--only", PM2_APP_NAME]);
        }

        if (startResult.status !== 0) {
            console.log("PM2 failed to start the bot. You can try again manually later.");
            return summary;
        }

        summary.started = true;
    }

    const shouldEnableStartup = await askYesNo(
        rl,
        "Enable startup on boot (runs pm2 startup and pm2 save)",
        true
    );

    if (shouldEnableStartup) {
        summary.startupEnabled = configurePm2StartupForBoot(pm2Command);

        const saveResult = runCommand(pm2Command, ["save"]);
        if (saveResult.status !== 0) {
            console.log("pm2 save failed. Run pm2 save manually after PM2 is configured.");
        }
    }

    return summary;
}

async function main() {
    if (!fs.existsSync(EXAMPLE_ENV_FILE_PATH)) {
        throw new Error("example.env.jsonc is missing.");
    }

    const template = readJsoncFile(EXAMPLE_ENV_FILE_PATH);
    const existing = readExistingEnv();

    const rl = readline.createInterface({ input: stdin, output: stdout });

    try {
        console.log("Mongocord setup");
        if (fs.existsSync(ENV_FILE_PATH)) {
            console.log("Existing env.json detected. Leave a field blank to keep its current value.");
        }

        const token = await askField(rl, "Discord bot token", {
            defaultValue: existing.token,
            required: true,
            hideDefault: true
        });

        const clientId = await askField(rl, "Discord application client ID", {
            defaultValue: existing.clientId,
            required: true
        });

        const mongoUri = await askField(rl, "MongoDB URI", {
            defaultValue: existing.mongoUri,
            required: true,
            hideDefault: true
        });

        const stateDatabaseName = await askField(rl, "State database name (optional)", {
            defaultValue: existing.stateDatabaseName
        });

        const devAdmins = await askField(rl, "Dev admin Discord user IDs (comma or space separated)", {
            defaultValue: Array.isArray(existing.devAdmins) ? existing.devAdmins.join(", ") : "",
            required: true,
            parser: parseDevAdmins
        });

        const env = {
            token,
            clientId,
            mongoUri,
            ...(stateDatabaseName ? { stateDatabaseName } : {}),
            devAdmins
        };

        validateEnvShape(env);
        fs.writeFileSync(ENV_FILE_PATH, `${JSON.stringify(env, null, 4)}\n`, "utf8");
        console.log("Wrote env.json successfully.");

        if (!template || typeof template !== "object") {
            console.warn("Warning: example.env.jsonc could not be parsed into an object.");
        }

        const commandsRegistered = registerSlashCommands();
        const pm2Summary = await configurePm2(rl);

        console.log("Setup complete.");

        if (commandsRegistered) {
            console.log("Discord slash commands are registered.");
        }
        else {
            console.log("Slash command registration failed. Run npm run register manually.");
        }

        if (pm2Summary.started) {
            console.log("Mongocord is running under PM2.");
        }
        else if (pm2Summary.available) {
            console.log("PM2 is configured, but startup was not triggered in this run.");
        }
        else if (pm2Summary.usedPm2) {
            console.log("PM2 setup was requested, but PM2 is still not installed/configured.");
        }
        else {
            console.log("PM2 setup was skipped.");
        }

        if (pm2Summary.startupEnabled) {
            console.log("Startup on boot is enabled.");
        }
    }
    finally {
        rl.close();
    }
}

main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
});
