require("./setEnvs");

const { Events } = require("discord.js");
const client = require("./client");
const { syncCommands } = require("./launchCommands");
const { loadModules } = require("./launchModules");
const { ensureStateIndexes } = require("./lib/state");
const { getMongoClient } = require("./lib/mongo");
const { replyPrivately } = require("./lib/access");

const THEME_GREEN = 0xb7e4c7;
global.THEME_GREEN = THEME_GREEN;

function shouldDeferCommand(moduleDefinition) {
    return moduleDefinition.data?.deferReply !== false;
}

function matchesCustomId(subscription, customId) {
    if (typeof subscription === "string") {
        return subscription === customId;
    }

    return subscription instanceof RegExp && subscription.test(customId);
}

async function main() {
    const modules = await loadModules();
    const commandModules = new Map(
        modules
            .filter(moduleDefinition => moduleDefinition.data?.command)
            .map(moduleDefinition => [moduleDefinition.data.command.name, moduleDefinition])
    );

    const subscribedInteractionModules = modules.filter(moduleDefinition =>
        Array.isArray(moduleDefinition.subscribedCustomIds || moduleDefinition.subscribedButtons)
        && typeof moduleDefinition.onbutton === "function"
    );

    const eventHandlers = new Map();
    for (const eventName of Object.values(Events)) {
        const handlers = modules.filter(moduleDefinition => typeof moduleDefinition[eventName] === "function");
        if (handlers.length) {
            eventHandlers.set(eventName, handlers);
        }
    }

    await Promise.all([
        getMongoClient(),
        ensureStateIndexes(),
        syncCommands()
    ]);

    for (const [eventName, handlers] of eventHandlers.entries()) {
        client.on(eventName, (...args) => {
            for (const handlerModule of handlers) {
                Promise.resolve(handlerModule[eventName](...args))
                    .catch(error => {
                        console.error(`[${handlerModule.name}] ${eventName} failed`, error);
                    });
            }
        });
    }

    client.on(Events.InteractionCreate, async interaction => {
        try {
            if (interaction.isAutocomplete()) {
                const moduleDefinition = commandModules.get(interaction.commandName);
                if (moduleDefinition?.autocomplete) {
                    await moduleDefinition.autocomplete(interaction);
                }
                return;
            }

            if (interaction.isChatInputCommand()) {
                const moduleDefinition = commandModules.get(interaction.commandName);
                if (!moduleDefinition?.execute) {
                    return;
                }

                if (shouldDeferCommand(moduleDefinition)) {
                    const isPrivate = interaction.options.getBoolean("private") ?? false;
                    await interaction.deferReply({ ephemeral: isPrivate });
                }

                await moduleDefinition.execute(interaction);
                return;
            }

            if ("customId" in interaction) {
                const matchingModules = subscribedInteractionModules.filter(moduleDefinition => {
                    const subscriptions = moduleDefinition.subscribedCustomIds || moduleDefinition.subscribedButtons || [];
                    return subscriptions.some(subscription => matchesCustomId(subscription, interaction.customId));
                });

                if (!matchingModules.length) {
                    return;
                }

                for (const moduleDefinition of matchingModules) {
                    await moduleDefinition.onbutton(interaction);
                }
            }
        }
        catch (error) {
            const interactionLabel = interaction.isChatInputCommand()
                ? `/${interaction.commandName}`
                : ("customId" in interaction ? interaction.customId : String(interaction.type));
            console.error(`Interaction failed for ${interactionLabel}`, error);
            try {
                await replyPrivately(interaction, `Something went wrong: ${error.message}`);
            }
            catch (replyError) {
                console.error(`Failed to notify user about error for ${interactionLabel}`, replyError);
            }
        }
    });

    client.once(Events.ClientReady, readyClient => {
        console.log(`Logged in as ${readyClient.user.tag}`);
    });

    await client.login(process.env.token);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
