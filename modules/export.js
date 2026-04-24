const {
    AttachmentBuilder,
    LabelBuilder,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");
const { replyPrivately } = require("../lib/access");
const { makeCustomId, parseCustomId } = require("../lib/customIds");
const { addPrivateOption, createStatusEmbed, shorten, withSafeMentions } = require("../lib/discordViews");
const { respond } = require("../lib/interactions");
const { listCollectionNames, listDatabaseNames } = require("../lib/mongoAdmin");
const { parseMongoExpression } = require("../lib/mongoExpression");
const { getDatabase, toExtendedJson } = require("../lib/mongo");
const { createSession, deleteSession, getSession } = require("../lib/sessions");

const EXPORT_MODAL_PREFIX = "exportModal";
const MAX_EXPORT_BYTES = 9_500_000;

module.exports = {
    data: {
        deferReply: false,
        command: new SlashCommandBuilder()
            .setName("export")
            .setDescription("Export the results of a MongoDB search query to JSON")
            .addStringOption(option =>
                option
                    .setName("database")
                    .setDescription("Database name")
                    .setRequired(true)
                    .setAutocomplete(true)
            )
            .addStringOption(option =>
                option
                    .setName("collection")
                    .setDescription("Collection name")
                    .setRequired(true)
                    .setAutocomplete(true)
            )
            .addBooleanOption(addPrivateOption)
    },

    subscribedCustomIds: [/^exportModal\|/],

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);

        if (focused.name === "database") {
            const names = await listDatabaseNames();
            await interaction.respond(
                names
                    .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
                    .slice(0, 25)
                    .map(name => ({ name, value: name }))
            );
            return;
        }

        if (focused.name === "collection") {
            const databaseName = interaction.options.getString("database");
            if (!databaseName) {
                await interaction.respond([]);
                return;
            }

            const names = await listCollectionNames(databaseName);
            await interaction.respond(
                names
                    .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
                    .slice(0, 25)
                    .map(name => ({ name, value: name }))
            );
            return;
        }

        await interaction.respond([]);
    },

    async execute(interaction) {
        const modalSessionId = createSession("exportModal", {
            ownerId: interaction.user.id,
            database: interaction.options.getString("database", true),
            collection: interaction.options.getString("collection", true),
            private: interaction.options.getBoolean("private") ?? false
        });

        await interaction.showModal(buildExportModal(modalSessionId, getSession(modalSessionId, "exportModal")));
    },

    async onbutton(interaction) {
        if (!interaction.isModalSubmit() || !interaction.customId.startsWith(`${EXPORT_MODAL_PREFIX}|`)) {
            return;
        }

        const [, sessionId] = parseCustomId(interaction.customId);
        const session = getSession(sessionId, "exportModal");

        if (!session) {
            await interaction.reply(withSafeMentions({
                content: "That export dialog expired. Run `/export` again.",
                ephemeral: true
            }));
            return;
        }

        if (session.ownerId !== interaction.user.id) {
            await replyPrivately(interaction, "Only the original requester can submit that export.");
            return;
        }

        await interaction.deferReply({ ephemeral: session.private });

        const parsed = parseFindSources({
            filterSource: interaction.fields.getTextInputValue("filter") || "{}",
            projectionSource: interaction.fields.getTextInputValue("projection") || "{}",
            sortSource: interaction.fields.getTextInputValue("sort") || "{}",
            optionsSource: interaction.fields.getTextInputValue("options") || "{}"
        });

        const documents = await fetchFindDocuments({
            database: session.database,
            collection: session.collection,
            parsed
        });
        const contents = toExtendedJson(documents, false);
        const size = Buffer.byteLength(contents, "utf8");
        if (size > MAX_EXPORT_BYTES) {
            throw new Error("That export is too large for a Discord attachment. Narrow the query or use a lower limit.");
        }

        const file = new AttachmentBuilder(Buffer.from(contents, "utf8"), {
            name: `${session.collection}-export.json`
        });

        await respond(interaction, {
            embeds: [
                createStatusEmbed({
                    title: "Export Ready",
                    description:
                        `Exported ${documents.length} document(s) from \`${session.database}.${session.collection}\`.\n` +
                        `Attachment size: ${Math.max(1, Math.round(size / 1024))} KB`
                })
            ],
            files: [file]
        });

        deleteSession(sessionId);
    }
};

function buildExportModal(sessionId, session) {
    return new ModalBuilder()
        .setCustomId(makeCustomId(EXPORT_MODAL_PREFIX, sessionId))
        .setTitle(shorten(`Export ${session.database}.${session.collection}`, 45))
        .addLabelComponents(
            createModalTextInputLabel({
                customId: "filter",
                label: "Filter JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: "{}"
            }),
            createModalTextInputLabel({
                customId: "projection",
                label: "Projection JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: "{}"
            }),
            createModalTextInputLabel({
                customId: "sort",
                label: "Sort JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: "{}"
            }),
            createModalTextInputLabel({
                customId: "options",
                label: "Options JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: "{}"
            })
        );
}

async function fetchFindDocuments(session) {
    const database = await getDatabase(session.database);
    const collection = database.collection(session.collection);
    const options = normalizeFindOptions(session.parsed.options);

    const cursor = applyFindCursorOptions(
        collection.find(session.parsed.filter, {
            projection: session.parsed.projection
        }),
        session.parsed,
        options
    ).skip(options.skip);

    if (options.limit != null) {
        cursor.limit(options.limit);
    }

    return cursor.toArray();
}

function applyFindCursorOptions(cursor, parsed, options) {
    if (parsed.sort && Object.keys(parsed.sort).length) {
        cursor.sort(parsed.sort);
    }

    if (options.hint !== undefined) {
        cursor.hint(options.hint);
    }

    if (options.collation) {
        cursor.collation(options.collation);
    }

    if (options.maxTimeMS) {
        cursor.maxTimeMS(options.maxTimeMS);
    }

    return cursor;
}

function normalizeFindOptions(options) {
    return {
        skip: Math.max(0, Number(options.skip) || 0),
        limit: options.limit == null ? null : Math.max(0, Number(options.limit) || 0),
        hint: options.hint,
        collation: options.collation,
        maxTimeMS: options.maxTimeMS == null ? undefined : Number(options.maxTimeMS)
    };
}

function parseFindSources({ filterSource, projectionSource, sortSource, optionsSource }) {
    return {
        filter: parseMongoExpression(filterSource, {
            expect: "object",
            label: "filter",
            defaultValue: {}
        }),
        projection: parseMongoExpression(projectionSource, {
            expect: "object",
            label: "projection",
            defaultValue: {}
        }),
        sort: parseMongoExpression(sortSource, {
            expect: "object",
            label: "sort",
            defaultValue: {}
        }),
        options: parseMongoExpression(optionsSource, {
            expect: "object",
            label: "options",
            defaultValue: {}
        })
    };
}

function createModalTextInputLabel({
    customId,
    label,
    style,
    required,
    value
}) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setStyle(style)
        .setRequired(required);

    if (value) {
        input.setValue(value);
    }

    return new LabelBuilder()
        .setLabel(shorten(label, 45))
        .setTextInputComponent(input);
}
