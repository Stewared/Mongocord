const fs = require("node:fs");
const { jsonc } = require("jsonc");

const REQUIRED_FIELDS = [
    "token",
    "clientId",
    "mongoUri",
    "devAdmins"
];

function readJsoncFile(path) {
    try {
        return jsonc.parse(fs.readFileSync(path, "utf8"));
    }
    catch (error) {
        throw new Error(`Failed to read ${path}: ${error.message}`);
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

const env = readJsoncFile("./env.json");
validateEnvShape(env);

for (const [key, value] of Object.entries(env)) {
    process.env[key] = typeof value === "string" ? value : JSON.stringify(value);
}

module.exports = {
    env,
    example: readJsoncFile("./example.env.jsonc")
};

