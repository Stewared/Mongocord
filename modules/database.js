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
const { getDatabase, getMongoClient } = require("../lib/mongo");
const { replyPrivately } = require("../lib/access");
const { makeCustomId, parseCustomId } = require("../lib/customIds");
const { addPrivateOption, createStatusEmbed, shorten, withSafeMentions } = require("../lib/discordViews");
const { respond } = require("../lib/interactions");
const { listDatabaseNames, listDatabasesWithCollectionCounts } = require("../lib/mongoAdmin");
const { createSession, deleteSession, getSession } = require("../lib/sessions");

const DATABASE_DELETE_MODAL_PREFIX = "databaseDeleteModal";
const DATABASE_LIST_REFRESH_PREFIX = "databaseListRefresh";

function addDatabaseOption(option, name = "database", description = "Database name") {
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
            .setName("database")
            .setDescription("Create, rename, delete, or inspect MongoDB databases")
            .addSubcommand(subcommand =>
                subcommand
                    .setName("create")
                    .setDescription("Create a database by creating its first collection")
                    .addStringOption(option =>
                        option
                            .setName("name")
                            .setDescription("Database name")
                            .setRequired(true)
                    )
                    .addStringOption(option =>
                        option
                            .setName("starter_collection")
                            .setDescription("Optional starter collection, defaults to init")
                            .setRequired(false)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("delete")
                    .setDescription("Delete a database")
                    .addStringOption(addDatabaseOption)
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("rename")
                    .setDescription("Rename a database by cloning it to a new name and dropping the old one")
                    .addStringOption(addDatabaseOption)
                    .addStringOption(option =>
                        option
                            .setName("new_name")
                            .setDescription("New database name")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("list")
                    .setDescription("List visible databases")
                    .addBooleanOption(addPrivateOption)
            )
    },

    subscribedCustomIds: [/^databaseDeleteModal\|/, /^databaseListRefresh\|/],

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== "database") {
            await interaction.respond([]);
            return;
        }

        const choices = await listDatabaseNames();
        await interaction.respond(
            choices
                .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
                .slice(0, 25)
                .map(name => ({ name, value: name }))
        );
    },

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const isPrivate = interaction.options.getBoolean("private") ?? false;

        if (subcommand === "create") {
            const name = interaction.options.getString("name", true);
            const starterCollection = interaction.options.getString("starter_collection") || "init";
            const db = await getDatabase(name);
            await db.createCollection(starterCollection);

            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Database Created",
                        description: `Created \`${name}\` with starter collection \`${starterCollection}\`.`
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (subcommand === "delete") {
            const name = interaction.options.getString("database", true);
            const sessionId = createSession("databaseDeleteConfirm", {
                ownerId: interaction.user.id,
                database: name,
                private: isPrivate
            });

            await interaction.showModal(buildDeleteModal(sessionId, name));
            return;
        }

        if (subcommand === "rename") {
            const sourceName = interaction.options.getString("database", true);
            const targetName = interaction.options.getString("new_name", true);
            await cloneDatabase(sourceName, targetName);

            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Database Renamed",
                        description:
                            `Renamed \`${sourceName}\` to \`${targetName}\`.\n` +
                            "MongoDB has no native renameDatabase command, so the bot cloned the collections and then dropped the old database."
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (subcommand === "list") {
            const sessionId = createSession("databaseListView", {
                ownerId: interaction.user.id,
                private: isPrivate
            });

            await respond(interaction, {
                ...await buildDatabaseListPayload(sessionId),
                ephemeral: isPrivate
            });
        }
    },

    async onbutton(interaction) {
        if (interaction.isButton() && interaction.customId.startsWith(`${DATABASE_LIST_REFRESH_PREFIX}|`)) {
            const [, sessionId] = parseCustomId(interaction.customId);
            const session = getSession(sessionId, "databaseListView");

            if (!session) {
                await replyPrivately(interaction, "That database list view expired. Run /database list again.");
                return;
            }

            if (session.ownerId !== interaction.user.id) {
                await replyPrivately(interaction, "Only the original requester can refresh this database list.");
                return;
            }

            await interaction.update(await buildDatabaseListPayload(sessionId));
            return;
        }

        if (!interaction.isModalSubmit() || !interaction.customId.startsWith(`${DATABASE_DELETE_MODAL_PREFIX}|`)) {
            return;
        }

        const [, sessionId] = parseCustomId(interaction.customId);
        const session = getSession(sessionId, "databaseDeleteConfirm");

        if (!session) {
            await interaction.reply(withSafeMentions({
                content: "That database delete confirmation expired.",
                ephemeral: true
            }));
            return;
        }

        if (session.ownerId !== interaction.user.id) {
            await replyPrivately(interaction, "Only the original requester can confirm that database delete.");
            return;
        }

        const typedName = interaction.fields.getTextInputValue("name");
        if (typedName !== session.database) {
            await interaction.reply(withSafeMentions({
                content: "Delete cancelled because the typed database name did not match.",
                ephemeral: true
            }));
            deleteSession(sessionId);
            return;
        }

        await (await getDatabase(session.database)).dropDatabase();
        await respond(interaction, {
            embeds: [
                createStatusEmbed({
                    title: "Database Deleted",
                    description: `Deleted \`${session.database}\`.`
                })
            ],
            ephemeral: session.private
        });

        deleteSession(sessionId);
    }
};

async function buildDatabaseListPayload(sessionId) {
    const databases = await listDatabasesWithCollectionCounts();
    return {
        embeds: [
            createStatusEmbed({
                title: "Visible Databases",
                description: databases.length
                    ? databases.map(entry => `- \`${entry.name}\` (${entry.collectionCount} ${entry.collectionCount === 1 ? "collection" : "collections"})`).join("\n")
                    : "No databases were visible to the current Mongo connection."
            })
        ],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(makeCustomId(DATABASE_LIST_REFRESH_PREFIX, sessionId))
                    .setLabel("Refresh")
                    .setStyle(ButtonStyle.Secondary)
            )
        ]
    };
}

async function cloneDatabase(sourceName, targetName) {
    if (sourceName === targetName) {
        throw new Error("Source and target database names must differ.");
    }

    const client = await getMongoClient();
    const sourceDb = client.db(sourceName);
    const targetDb = client.db(targetName);
    const existingTargetCollections = await targetDb.listCollections({}, { nameOnly: true }).toArray();

    if (existingTargetCollections.length) {
        throw new Error(`Target database "${targetName}" already exists and is not empty.`);
    }

    const collections = await sourceDb.listCollections({}, { nameOnly: false }).toArray();

    for (const collectionInfo of collections) {
        const sourceCollection = sourceDb.collection(collectionInfo.name);
        const targetCollection = targetDb.collection(collectionInfo.name);
        const cursor = sourceCollection.find({});
        const batch = [];

        for await (const document of cursor) {
            batch.push(document);
            if (batch.length >= 500) {
                await targetCollection.insertMany(batch);
                batch.length = 0;
            }
        }

        if (batch.length) {
            await targetCollection.insertMany(batch);
        }

        const indexes = await sourceCollection.indexes();
        for (const index of indexes) {
            if (index.name === "_id_") {
                continue;
            }

            const {
                key,
                name,
                v: _ignoredVersion,
                ns: _ignoredNamespace,
                background: _ignoredBackground,
                ...indexOptions
            } = index;

            await targetCollection.createIndex(key, {
                name,
                ...indexOptions
            });
        }
    }

    await sourceDb.dropDatabase();
}

function buildDeleteModal(sessionId, databaseName) {
    return new ModalBuilder()
        .setCustomId(makeCustomId(DATABASE_DELETE_MODAL_PREFIX, sessionId))
        .setTitle(shorten(`Delete ${databaseName}`, 45))
        .addLabelComponents(
            createModalTextInputLabel({
                customId: "name",
                label: `Type ${databaseName} to confirm`,
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
