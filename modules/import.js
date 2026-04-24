const { SlashCommandBuilder } = require("discord.js");
const { getDatabase } = require("../lib/mongo");
const { requireDatabaseAdmin } = require("../lib/access");
const { addPrivateOption, createStatusEmbed } = require("../lib/discordViews");
const { respond } = require("../lib/interactions");
const { listCollectionNames, listDatabaseNames } = require("../lib/mongoAdmin");
const { parseMongoExpression } = require("../lib/mongoExpression");

module.exports = {
    data: {
        command: new SlashCommandBuilder()
            .setName("import")
            .setDescription("Import JSON documents into a MongoDB collection")
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
            .addStringOption(option =>
                option
                    .setName("type")
                    .setDescription("Whether the source is raw JSON text or a file upload")
                    .setRequired(true)
                    .addChoices(
                        { name: "array", value: "array" },
                        { name: "file", value: "file" }
                    )
            )
            .addStringOption(option =>
                option
                    .setName("json")
                    .setDescription("JSON array or single document")
                    .setRequired(false)
            )
            .addAttachmentOption(option =>
                option
                    .setName("file")
                    .setDescription("JSON file to import")
                    .setRequired(false)
            )
            .addBooleanOption(option =>
                option
                    .setName("override")
                    .setDescription("Replace existing documents with matching _id values")
                    .setRequired(false)
            )
            .addBooleanOption(addPrivateOption)
    },

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
        if (!await requireDatabaseAdmin(interaction)) {
            return;
        }

        const databaseName = interaction.options.getString("database", true);
        const collectionName = interaction.options.getString("collection", true);
        const type = interaction.options.getString("type", true);
        const override = interaction.options.getBoolean("override") ?? false;
        const isPrivate = interaction.options.getBoolean("private") ?? false;

        let sourceText;
        if (type === "file") {
            const attachment = interaction.options.getAttachment("file");
            if (!attachment) {
                throw new Error("Type `file` requires the `file` attachment option.");
            }

            const response = await fetch(attachment.url);
            sourceText = await response.text();
        }
        else {
            sourceText = interaction.options.getString("json");
            if (!sourceText) {
                throw new Error("Type `array` requires the `json` option.");
            }
        }

        const parsed = parseMongoExpression(sourceText, {
            expect: "any",
            label: "import payload",
            defaultValue: []
        });

        const documents = Array.isArray(parsed) ? parsed : [parsed];
        if (!documents.length) {
            throw new Error("The import payload did not contain any documents.");
        }

        const collection = (await getDatabase(databaseName)).collection(collectionName);
        const operations = documents.map(document => {
            if (override && document && typeof document === "object" && "_id" in document) {
                return {
                    replaceOne: {
                        filter: { _id: document._id },
                        replacement: document,
                        upsert: true
                    }
                };
            }

            return {
                insertOne: {
                    document
                }
            };
        });

        const result = await collection.bulkWrite(operations, {
            ordered: false
        });

        await respond(interaction, {
            embeds: [
                createStatusEmbed({
                    title: "Import Complete",
                    fields: [
                        {
                            name: "Collection",
                            value: `\`${databaseName}.${collectionName}\``
                        },
                        {
                            name: "Documents",
                            value: String(documents.length)
                        },
                        {
                            name: "Inserted",
                            value: String(result.insertedCount ?? 0)
                        },
                        {
                            name: "Upserted / Replaced",
                            value: String((result.upsertedCount ?? 0) + (result.modifiedCount ?? 0))
                        }
                    ]
                })
            ],
            ephemeral: isPrivate
        });
    }
};
