const { SlashCommandBuilder } = require("discord.js");
const { getGlobalConfig, getUserPreferences, removeDatabaseAdmin, setConfirmationsEnabled, setDatabaseAdmin } = require("../lib/state");
const { getDevAdminIds, requireDevAdmin } = require("../lib/access");
const { addPrivateOption, createStatusEmbed } = require("../lib/discordViews");
const { respond } = require("../lib/interactions");

module.exports = {
    data: {
        command: new SlashCommandBuilder()
            .setName("config")
            .setDescription("Manage bot access and personal safety settings")
            .addSubcommand(subcommand =>
                subcommand
                    .setName("confirmations")
                    .setDescription("Enable or disable your own confirmation prompts")
                    .addBooleanOption(option =>
                        option
                            .setName("enabled")
                            .setDescription("Whether confirmations should stay enabled")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("admin_add")
                    .setDescription("Grant someone database admin access")
                    .addUserOption(option =>
                        option
                            .setName("user")
                            .setDescription("The user to promote")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("admin_remove")
                    .setDescription("Remove someone's database admin access")
                    .addUserOption(option =>
                        option
                            .setName("user")
                            .setDescription("The user to demote")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("admin_list")
                    .setDescription("List current database admins")
                    .addBooleanOption(addPrivateOption)
            )
    },

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const isPrivate = interaction.options.getBoolean("private") ?? false;

        if (subcommand === "confirmations") {
            const enabled = interaction.options.getBoolean("enabled", true);
            await setConfirmationsEnabled(interaction.user.id, enabled);

            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Confirmations Updated",
                        description: `Confirmation prompts are now ${enabled ? "enabled" : "disabled"} for you.`
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (!await requireDevAdmin(interaction)) {
            return;
        }

        if (subcommand === "admin_add") {
            const user = interaction.options.getUser("user", true);
            await setDatabaseAdmin(user.id);

            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Database Admin Added",
                        description: `<@${user.id}> can now use the database commands.`
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (subcommand === "admin_remove") {
            const user = interaction.options.getUser("user", true);
            if (getDevAdminIds().has(user.id)) {
                await respond(interaction, {
                    embeds: [
                        createStatusEmbed({
                            title: "Cannot Remove Dev Admin",
                            description: "That user is a permanent dev admin from env.json and cannot be removed."
                        })
                    ],
                    ephemeral: isPrivate
                });
                return;
            }

            await removeDatabaseAdmin(user.id);
            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Database Admin Removed",
                        description: `<@${user.id}> no longer has database admin access.`
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (subcommand === "admin_list") {
            const config = await getGlobalConfig();
            const prefs = await getUserPreferences(interaction.user.id);
            const devAdmins = [...getDevAdminIds()].map(id => `<@${id}>`);
            const databaseAdmins = config.databaseAdmins
                .filter(id => !getDevAdminIds().has(id))
                .map(id => `<@${id}>`);

            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Admin Access",
                        fields: [
                            {
                                name: "Dev Admins",
                                value: devAdmins.length ? devAdmins.join(", ") : "None"
                            },
                            {
                                name: "Database Admins",
                                value: databaseAdmins.length ? databaseAdmins.join(", ") : "None"
                            },
                            {
                                name: "Your Confirmations",
                                value: prefs.confirmationsEnabled ? "Enabled" : "Disabled"
                            }
                        ]
                    })
                ],
                ephemeral: isPrivate
            });
        }
    }
};
