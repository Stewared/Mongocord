const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    LabelBuilder,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");
const { getDatabase } = require("../lib/mongo");
const { replyPrivately } = require("../lib/access");
const { makeCustomId, parseCustomId } = require("../lib/customIds");
const { addPrivateOption, createStatusEmbed, shorten, withSafeMentions } = require("../lib/discordViews");
const { respond } = require("../lib/interactions");
const { listCollectionNames, listCollectionsWithDocumentCounts, listDatabaseNames } = require("../lib/mongoAdmin");
const { createSession, deleteSession, getSession } = require("../lib/sessions");

const COLLECTION_DELETE_MODAL_PREFIX = "collectionDeleteModal";
const COLLECTION_LIST_REFRESH_PREFIX = "collectionListRefresh";

function addDatabaseOption(option) {
    return option
        .setName("database")
        .setDescription("Database name")
        .setRequired(true)
        .setAutocomplete(true);
}

function addCollectionOption(option, name = "collection", description = "Collection name") {
    return option
        .setName(name)
        .setDescription(description)
        .setRequired(true)
        .setAutocomplete(true);
}

module.exports = {
    data: {
        deferReply: false,
        command: new SlashCommandBuilder()
            .setName("collection")
            .setDescription("Create, rename, delete, or inspect MongoDB collections")
            .addSubcommand(subcommand =>
                subcommand
                    .setName("create")
                    .setDescription("Create a collection")
                    .addStringOption(addDatabaseOption)
                    .addStringOption(option =>
                        option
                            .setName("name")
                            .setDescription("New collection name")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("rename")
                    .setDescription("Rename a collection")
                    .addStringOption(addDatabaseOption)
                    .addStringOption(addCollectionOption)
                    .addStringOption(option =>
                        option
                            .setName("new_name")
                            .setDescription("New collection name")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("delete")
                    .setDescription("Delete a collection")
                    .addStringOption(addDatabaseOption)
                    .addStringOption(addCollectionOption)
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("list")
                    .setDescription("List collections in a database")
                    .addStringOption(addDatabaseOption)
                    .addBooleanOption(addPrivateOption)
            )
    },

    subscribedCustomIds: [/^collectionDeleteModal\|/, /^collectionListRefresh\|/],

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);

        if (focused.name === "database") {
            const choices = await listDatabaseNames();
            await interaction.respond(
                choices
                    .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
                    .slice(0, 25)
                    .map(name => ({ name, value: name }))
            );
            return;
        }

        const databaseName = interaction.options.getString("database");
        if (!databaseName) {
            await interaction.respond([]);
            return;
        }

        const choices = await listCollectionNames(databaseName);
        await interaction.respond(
            choices
                .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
                .slice(0, 25)
                .map(name => ({ name, value: name }))
        );
    },

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const databaseName = interaction.options.getString("database", true);
        const isPrivate = interaction.options.getBoolean("private") ?? false;
        const db = await getDatabase(databaseName);

        if (subcommand === "create") {
            const name = interaction.options.getString("name", true);
            await db.createCollection(name);
            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Collection Created",
                        description: `Created \`${databaseName}.${name}\`.`
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (subcommand === "rename") {
            const collectionName = interaction.options.getString("collection", true);
            const newName = interaction.options.getString("new_name", true);
            await db.collection(collectionName).rename(newName);
            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Collection Renamed",
                        description: `Renamed \`${databaseName}.${collectionName}\` to \`${newName}\`.`
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (subcommand === "delete") {
            const collectionName = interaction.options.getString("collection", true);
            const sessionId = createSession("collectionDeleteConfirm", {
                ownerId: interaction.user.id,
                database: databaseName,
                collection: collectionName,
                private: isPrivate
            });

            await interaction.showModal(buildDeleteModal(sessionId, databaseName, collectionName));
            return;
        }

        if (subcommand === "list") {
            const sessionId = createSession("collectionListView", {
                ownerId: interaction.user.id,
                database: databaseName,
                private: isPrivate
            });

            await respond(interaction, {
                ...await buildCollectionListPayload(databaseName, sessionId),
                ephemeral: isPrivate
            });
        }
    },

    async onbutton(interaction) {
        if (interaction.isButton() && interaction.customId.startsWith(`${COLLECTION_LIST_REFRESH_PREFIX}|`)) {
            const [, sessionId] = parseCustomId(interaction.customId);
            const session = getSession(sessionId, "collectionListView");

            if (!session) {
                await replyPrivately(interaction, "That collection list view expired. Run /collection list again.");
                return;
            }

            if (session.ownerId !== interaction.user.id) {
                await replyPrivately(interaction, "Only the original requester can refresh this collection list.");
                return;
            }

            await interaction.update(await buildCollectionListPayload(session.database, sessionId));
            return;
        }

        if (!interaction.isModalSubmit() || !interaction.customId.startsWith(`${COLLECTION_DELETE_MODAL_PREFIX}|`)) {
            return;
        }

        const [, sessionId] = parseCustomId(interaction.customId);
        const session = getSession(sessionId, "collectionDeleteConfirm");

        if (!session) {
            await interaction.reply(withSafeMentions({
                content: "That collection delete confirmation expired.",
                ephemeral: true
            }));
            return;
        }

        if (session.ownerId !== interaction.user.id) {
            await replyPrivately(interaction, "Only the original requester can confirm that collection delete.");
            return;
        }

        const typedName = interaction.fields.getTextInputValue("name");
        if (typedName !== session.collection) {
            await interaction.reply(withSafeMentions({
                content: "Delete cancelled because the typed collection name did not match.",
                ephemeral: true
            }));
            deleteSession(sessionId);
            return;
        }

        await (await getDatabase(session.database)).collection(session.collection).drop();
        await respond(interaction, {
            embeds: [
                createStatusEmbed({
                    title: "Collection Deleted",
                    description: `Deleted \`${session.database}.${session.collection}\`.`
                })
            ],
            ephemeral: session.private
        });

        deleteSession(sessionId);
    }
};

async function buildCollectionListPayload(databaseName, sessionId) {
    const collections = await listCollectionsWithDocumentCounts(databaseName);
    return {
        embeds: [
            createStatusEmbed({
                title: `Collections in ${databaseName}`,
                description: collections.length
                    ? collections.map(entry => `- \`${entry.name}\` (${entry.documentCount} ${entry.documentCount === 1 ? "document" : "documents"})`).join("\n")
                    : "No visible collections were found."
            })
        ],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(makeCustomId(COLLECTION_LIST_REFRESH_PREFIX, sessionId))
                    .setLabel("Refresh")
                    .setStyle(ButtonStyle.Secondary)
            )
        ]
    };
}

function buildDeleteModal(sessionId, databaseName, collectionName) {
    return new ModalBuilder()
        .setCustomId(makeCustomId(COLLECTION_DELETE_MODAL_PREFIX, sessionId))
        .setTitle(shorten(`Delete ${databaseName}.${collectionName}`, 45))
        .addLabelComponents(
            createModalTextInputLabel({
                customId: "name",
                label: `Type ${collectionName} to confirm`,
                style: TextInputStyle.Short,
                required: true
            })
        );
}

function createModalTextInputLabel({
    customId,
    label,
    style,
    required
}) {
    return new LabelBuilder()
        .setLabel(shorten(label, 45))
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId(customId)
                .setStyle(style)
                .setRequired(required)
        );
}
