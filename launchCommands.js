require("./setEnvs");

const { REST, Routes } = require("discord.js");
const { env } = require("./setEnvs");
const { loadModules } = require("./launchModules");

async function getCommandPayloads() {
    const modules = await loadModules();

    return modules
        .filter(moduleDefinition => moduleDefinition.data?.command)
        .map(moduleDefinition => moduleDefinition.data.command.toJSON());
}

async function syncCommands() {
    const commands = await getCommandPayloads();
    const rest = new REST({ version: "10" }).setToken(env.token);

    // try {
    //     await rest.put(
    //         Routes.applicationGuildCommands(env.clientId, "983074750165299250"),
    //         { body: [] }
    //     );
    //     console.log(`Cleared commands for guild ${"983074750165299250"}`);
    // } catch (err) {
    //     console.error(err);
    // }

    await rest.put(
        Routes.applicationCommands(env.clientId),
        { body: commands }
    );

    return `Registered ${commands.length} global command(s).`;
}

module.exports = {
    getCommandPayloads,
    syncCommands
};

if (require.main === module) {
    syncCommands()
        .then(message => {
            console.log(message);
        })
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
}

