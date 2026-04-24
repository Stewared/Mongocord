const { SlashCommandBuilder } = require("discord.js");
const { getMongoClient } = require("../lib/mongo");
const { respond } = require("../lib/interactions");
const { addPrivateOption, createStatusEmbed } = require("../lib/discordViews");

module.exports = {
    data: {
        command: new SlashCommandBuilder()
            .setName("ping")
            .setDescription("Check whether the bot and MongoDB connection are alive")
            .addBooleanOption(addPrivateOption)
    },

    async execute(interaction) {
        const before = Date.now();
        await getMongoClient();
        const mongoMs = Date.now() - before;

        await respond(interaction, {
            embeds: [
                createStatusEmbed({
                    title: "Connection Check",
                    fields: [
                        {
                            name: "Discord Heartbeat",
                            value: `${Math.round(interaction.client.ws.ping)}ms`
                        },
                        {
                            name: "Mongo Connection",
                            value: `${mongoMs}ms`
                        }
                    ]
                })
            ],
            ephemeral: interaction.options.getBoolean("private") ?? false
        });
    }
};
