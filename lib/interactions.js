const { withSafeMentions } = require("./discordViews");

async function respond(interaction, payload) {
    const safePayload = payload && typeof payload === "object"
        ? withSafeMentions(payload)
        : payload;

    if (interaction.deferred) {
        return interaction.editReply(safePayload);
    }

    if (interaction.replied) {
        return interaction.followUp(safePayload);
    }

    return interaction.reply(safePayload);
}

async function respondEphemeral(interaction, content) {
    return respond(interaction, {
        content,
        ephemeral: true
    });
}

module.exports = {
    respond,
    respondEphemeral
};
