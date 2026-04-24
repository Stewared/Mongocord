const fs = require("node:fs/promises");
const path = require("node:path");

async function getModuleFiles(rootDir) {
    const dirEntries = await fs.readdir(rootDir, { withFileTypes: true });
    const discovered = [];

    for (const entry of dirEntries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            discovered.push(...await getModuleFiles(fullPath));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(".js")) {
            discovered.push(fullPath);
        }
    }

    return discovered;
}

async function loadModules(rootDir = path.join(__dirname, "modules")) {
    const files = await getModuleFiles(rootDir);
    const modules = [];

    for (const file of files) {
        delete require.cache[require.resolve(file)];
        const loaded = require(file);
        const moduleDefinition = loaded.default || loaded;
        const relativePath = path.relative(rootDir, file).replaceAll("\\", "/");

        modules.push({
            ...moduleDefinition,
            file,
            name: moduleDefinition.name || relativePath.replace(/\.js$/i, "")
        });
    }

    return modules.sort((left, right) => (left.data?.priority ?? 100) - (right.data?.priority ?? 100));
}

module.exports = {
    loadModules
};

