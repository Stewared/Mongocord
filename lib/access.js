const { env } = require("../setEnvs");
const { getGlobalConfig } = require("./state");
const { withSafeMentions } = require("./discordViews");

function getDevAdminIds() {
    return new Set(env.devAdmins.map(String));
}

function isDevAdmin(userId) {
    return getDevAdminIds().has(String(userId));
}

async function isDatabaseAdmin(userId) {
    if (isDevAdmin(userId)) {
        return true;
    }

    const config = await getGlobalConfig();
    return config.databaseAdmins.includes(String(userId));
}

async function requireDatabaseAdmin(interaction) {
    if (await isDatabaseAdmin(interaction.user.id)) {
        return true;
    }

    await replyPrivately(interaction, "You do not have database admin access for this bot.");
    return false;
}

async function requireDevAdmin(interaction) {
    if (isDevAdmin(interaction.user.id)) {
        return true;
    }

    await replyPrivately(interaction, "Only a dev admin can do that.");
    return false;
}

async function replyPrivately(interaction, content) {
    if (typeof interaction.respond === "function" && typeof interaction.reply !== "function") {
        return null;
    }

    if (interaction.deferred || interaction.replied) {
        if (typeof interaction.followUp === "function") {
            return interaction.followUp(withSafeMentions({
                content,
                ephemeral: true
            }));
        }

        return null;
    }

    if (typeof interaction.reply === "function") {
        return interaction.reply(withSafeMentions({
            content,
            ephemeral: true
        }));
    }

    return null;
}

module.exports = {
    getDevAdminIds,
    isDatabaseAdmin,
    isDevAdmin,
    requireDatabaseAdmin,
    requireDevAdmin,
    replyPrivately
};
