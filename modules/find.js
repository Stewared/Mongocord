const crypto = require("node:crypto");
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    LabelBuilder,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");
const client = require("../client");
const { isDevAdmin, replyPrivately } = require("../lib/access");
const { makeCustomId, parseCustomId } = require("../lib/customIds");
const {
    createComponentsV2Payload,
    createPagerRow,
    createSeparator,
    createText,
    getThemeGreen,
    shorten,
    addPrivateOption,
    withSafeMentions
} = require("../lib/discordViews");
const {
    makeDocumentPreview,
    pickResultPageSize,
    prepareEditableDocument,
    restoreTrimmedFields,
    summarizeDocumentChanges
} = require("../lib/documentTools");
const { respond } = require("../lib/interactions");
const { listCollectionNames, listDatabaseNames } = require("../lib/mongoAdmin");
const { parseMongoExpression } = require("../lib/mongoExpression");
const { EJSON, getDatabase, toExtendedJson } = require("../lib/mongo");
const { createSession, deleteSession, getSession, setSessionData } = require("../lib/sessions");
const { getRecentQuery, getUserPreferences, listRecentQueries, upsertRecentQuery } = require("../lib/state");

const FIND_MODAL_PREFIX = "findModal";
const FIND_VIEW_PREFIX = "find";
const FIND_EDIT_MODAL_PREFIX = "findEditModal";
const FIND_EDIT_CONFIRM_PREFIX = "findEditConfirm";
const FIND_DELETE_MODAL_PREFIX = "findDeleteModal";

const MAX_FIND_RESULTS_PER_PAGE = 5;
const QUICK_FIELD_SAMPLE_LIMIT = 12;
const QUICK_FIELD_DEPTH = 2;

module.exports = {
    data: {
        deferReply: false,
        command: new SlashCommandBuilder()
            .setName("find")
            .setDescription("Search MongoDB collections with interactive find tools")
            .addSubcommand(subcommand =>
                subcommand
                    .setName("query")
                    .setDescription("Search a collection with the full find editor")
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
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("quick")
                    .setDescription("Quick search with an inline filter field")
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
                            .setName("filter")
                            .setDescription("Inline filter JSON")
                            .setRequired(false)
                            .setAutocomplete(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("recent")
                    .setDescription("Open a saved recent search query")
                    .addStringOption(option =>
                        option
                            .setName("name")
                            .setDescription("Saved query name")
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
    },

    subscribedCustomIds: [
        /^findModal\|/,
        /^find\|/,
        /^findEditModal\|/,
        /^findEditConfirm\|/,
        /^findDeleteModal\|/
    ],

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand();

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

        if (focused.name === "collection") {
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
            return;
        }

        if (subcommand === "recent" && focused.name === "name") {
            const choices = await listRecentQueries(interaction.user.id, focused.value);
            await interaction.respond(
                choices.map(entry => ({
                    name: shorten(`${entry.name} (${entry.database}.${entry.collection})`, 100),
                    value: entry.name
                }))
            );
            return;
        }

        if (subcommand === "quick" && focused.name === "filter") {
            const suggestions = await buildQuickFilterSuggestions(interaction);
            await interaction.respond(
                suggestions.map(value => ({
                    name: shorten(value, 100),
                    value
                }))
            );
            return;
        }

        await interaction.respond([]);
    },

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const isPrivate = interaction.options.getBoolean("private") ?? false;

        if (subcommand === "query") {
            const modalSessionId = createSession("findModal", {
                ownerId: interaction.user.id,
                database: interaction.options.getString("database", true),
                collection: interaction.options.getString("collection", true),
                private: isPrivate,
                recentName: null,
                initial: {
                    filterSource: "{}",
                    projectionSource: "{}",
                    sortSource: "{}",
                    optionsSource: "{}",
                    saveName: ""
                }
            });

            await interaction.showModal(buildFindModal(modalSessionId, getSession(modalSessionId, "findModal")));
            return;
        }

        if (subcommand === "quick") {
            await interaction.deferReply({ ephemeral: isPrivate });
            await runFindQuery(interaction, {
                private: isPrivate,
                database: interaction.options.getString("database", true),
                collection: interaction.options.getString("collection", true),
                recentName: null,
                sources: {
                    filterSource: interaction.options.getString("filter") || "{}",
                    projectionSource: "{}",
                    sortSource: "{}",
                    optionsSource: "{}",
                    saveName: ""
                },
                saveRecent: false
            });
            return;
        }

        if (subcommand === "recent") {
            const recentName = interaction.options.getString("name", true);
            const recent = await getRecentQuery(interaction.user.id, recentName);

            if (!recent) {
                await interaction.reply(withSafeMentions({
                    content: `No saved recent query named "${recentName}" was found.`,
                    ephemeral: true
                }));
                return;
            }

            const modalSessionId = createSession("findModal", {
                ownerId: interaction.user.id,
                database: recent.database,
                collection: recent.collection,
                private: isPrivate,
                recentName: recent.name,
                initial: {
                    filterSource: recent.filterSource,
                    projectionSource: recent.projectionSource,
                    sortSource: recent.sortSource,
                    optionsSource: recent.optionsSource,
                    saveName: recent.name
                }
            });

            await interaction.showModal(buildFindModal(modalSessionId, getSession(modalSessionId, "findModal")));
        }
    },

    async onbutton(interaction) {
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith(`${FIND_MODAL_PREFIX}|`)) {
                await handleFindModalSubmit(interaction);
                return;
            }

            if (interaction.customId.startsWith(`${FIND_EDIT_MODAL_PREFIX}|`)) {
                await handleFindEditModalSubmit(interaction);
                return;
            }

            if (interaction.customId.startsWith(`${FIND_DELETE_MODAL_PREFIX}|`)) {
                await handleFindDeleteModalSubmit(interaction);
            }
            return;
        }

        if (!interaction.isButton()) {
            return;
        }

        if (interaction.customId.startsWith(`${FIND_EDIT_CONFIRM_PREFIX}|`)) {
            await handleEditConfirmationButton(interaction);
            return;
        }

        if (!interaction.customId.startsWith(`${FIND_VIEW_PREFIX}|`)) {
            return;
        }

        const [, sessionId, action, value] = parseCustomId(interaction.customId);
        const session = getSession(sessionId, "findResults");

        if (!session) {
            await replyPrivately(interaction, "That find session expired. Run the query again.");
            return;
        }

        if (!canUseSession(interaction, session)) {
            await replyPrivately(interaction, "Only the original requester can use these controls.");
            return;
        }

        if (action === "page") {
            const nextPage = session.page + (value === "next" ? 1 : -1);
            await refreshFindInteraction(interaction, sessionId, nextPage);
            return;
        }

        if (action === "refresh") {
            await refreshFindInteraction(interaction, sessionId, session.page);
            return;
        }

        if (action === "download") {
            const document = await getFullDocumentForItem(session, value);
            const file = new AttachmentBuilder(
                Buffer.from(toExtendedJson(document, false), "utf8"),
                { name: `${session.collection}-${sanitizeFileName(String(document._id))}.json` }
            );

            await interaction.reply(withSafeMentions({
                content: `Exported \`${session.database}.${session.collection}\` document \`${String(document._id)}\`.`,
                files: [file],
                ephemeral: true
            }));
            return;
        }

        if (action === "edit") {
            const document = await getFullDocumentForItem(session, value);
            const { editableDocument, trimmedKeys } = prepareEditableDocument(document);
            const editSessionId = createSession("findEdit", {
                ownerId: interaction.user.id,
                resultSessionId: sessionId,
                database: session.database,
                collection: session.collection,
                idSource: toExtendedJson(document._id, false),
                originalDocument: document,
                trimmedKeys
            });

            const modal = new ModalBuilder()
                .setCustomId(makeCustomId(FIND_EDIT_MODAL_PREFIX, editSessionId))
                .setTitle(shorten(`Edit ${session.collection}`, 45))
                .addLabelComponents(
                    createModalTextInputLabel({
                        customId: "document",
                        label: "Replacement document JSON",
                        style: TextInputStyle.Paragraph,
                        required: true,
                        value: toExtendedJson(editableDocument, false).slice(0, 4000)
                    })
                );

            await interaction.showModal(modal);
            return;
        }

        if (action === "delete") {
            const item = session.items?.[value];
            if (!item) {
                await replyPrivately(interaction, "That document is no longer in the current page cache. Refresh and try again.");
                return;
            }

            const preferences = await getUserPreferences(interaction.user.id);
            if (!preferences.confirmationsEnabled) {
                await deleteDocumentById(session, item.idSource);
                await refreshFindInteraction(interaction, sessionId, session.page, `Deleted document \`${item.idLabel}\`.`);
                return;
            }

            const deleteSessionId = createSession("findDelete", {
                ownerId: interaction.user.id,
                resultSessionId: sessionId,
                database: session.database,
                collection: session.collection,
                idSource: item.idSource,
                idLabel: item.idLabel
            });

            const modal = new ModalBuilder()
                .setCustomId(makeCustomId(FIND_DELETE_MODAL_PREFIX, deleteSessionId))
                .setTitle("Confirm delete")
                .addLabelComponents(
                    createModalTextInputLabel({
                        customId: "confirmation",
                        label: shorten(`Type DELETE to remove ${item.idLabel}`, 45),
                        style: TextInputStyle.Short,
                        required: true
                    })
                );

            await interaction.showModal(modal);
        }
    }
};

function buildFindModal(sessionId, modalSession) {
    return new ModalBuilder()
        .setCustomId(makeCustomId(FIND_MODAL_PREFIX, sessionId))
        .setTitle(shorten(`Find ${modalSession.database}.${modalSession.collection}`, 45))
        .addLabelComponents(
            createModalTextInputLabel({
                customId: "filter",
                label: "Filter JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: modalSession.initial.filterSource || "{}"
            }),
            createModalTextInputLabel({
                customId: "projection",
                label: "Projection JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: modalSession.initial.projectionSource || "{}"
            }),
            createModalTextInputLabel({
                customId: "sort",
                label: "Sort JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: modalSession.initial.sortSource || "{}"
            }),
            createModalTextInputLabel({
                customId: "options",
                label: "Options JSON",
                style: TextInputStyle.Paragraph,
                required: false,
                value: modalSession.initial.optionsSource || "{}"
            }),
            createModalTextInputLabel({
                customId: "save_name",
                label: "Recent query name",
                style: TextInputStyle.Short,
                required: false,
                value: modalSession.initial.saveName || ""
            })
        );
}

async function handleFindModalSubmit(interaction) {
    const [, sessionId] = parseCustomId(interaction.customId);
    const modalSession = getSession(sessionId, "findModal");

    if (!modalSession) {
        await interaction.reply(withSafeMentions({
            content: "That find editor expired. Run `/find query` again.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, modalSession)) {
        await replyPrivately(interaction, "Only the original requester can submit that modal.");
        return;
    }

    await interaction.deferReply({ ephemeral: modalSession.private });

    await runFindQuery(interaction, {
        private: modalSession.private,
        database: modalSession.database,
        collection: modalSession.collection,
        recentName: modalSession.recentName,
        sources: {
            filterSource: interaction.fields.getTextInputValue("filter") || "{}",
            projectionSource: interaction.fields.getTextInputValue("projection") || "{}",
            sortSource: interaction.fields.getTextInputValue("sort") || "{}",
            optionsSource: interaction.fields.getTextInputValue("options") || "{}",
            saveName: interaction.fields.getTextInputValue("save_name") || ""
        },
        saveRecent: true
    });

    deleteSession(sessionId);
}

async function runFindQuery(interaction, input) {
    const parsed = parseFindSources(input.sources);
    const storedName = input.saveRecent
        ? await upsertRecentQuery(interaction.user.id, input.recentName, {
            name: input.sources.saveName,
            database: input.database,
            collection: input.collection,
            filterSource: input.sources.filterSource,
            projectionSource: input.sources.projectionSource,
            sortSource: input.sources.sortSource,
            optionsSource: input.sources.optionsSource
        })
        : input.recentName;

    const resultSession = {
        ownerId: interaction.user.id,
        private: input.private,
        database: input.database,
        collection: input.collection,
        recentName: storedName,
        sources: {
            ...input.sources,
            saveName: storedName || ""
        },
        parsed,
        pageSize: null,
        page: 0,
        messageRef: null,
        items: {}
    };

    const resultSessionId = createSession("findResults", resultSession);
    const { payload, nextSession } = await buildFindPayload(resultSessionId, resultSession, 0);
    setSessionData(resultSessionId, nextSession);

    const message = await interaction.editReply(payload);
    if (!nextSession.private && message?.id) {
        nextSession.messageRef = {
            channelId: message.channelId,
            messageId: message.id
        };
        setSessionData(resultSessionId, nextSession);
    }
}

async function handleFindEditModalSubmit(interaction) {
    const [, sessionId] = parseCustomId(interaction.customId);
    const editSession = getSession(sessionId, "findEdit");

    if (!editSession) {
        await interaction.reply(withSafeMentions({
            content: "That edit session expired. Open the document again from the results view.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, editSession)) {
        await replyPrivately(interaction, "Only the original requester can submit that edit.");
        return;
    }

    const editedDocument = parseMongoExpression(interaction.fields.getTextInputValue("document"), {
        expect: "object",
        label: "replacement document"
    });
    const mergedDocument = restoreTrimmedFields(editedDocument, editSession.originalDocument, editSession.trimmedKeys);
    const summary = summarizeDocumentChanges(editSession.originalDocument, mergedDocument);

    const confirmSessionId = createSession("findEditConfirm", {
        ownerId: interaction.user.id,
        resultSessionId: editSession.resultSessionId,
        database: editSession.database,
        collection: editSession.collection,
        idSource: editSession.idSource,
        mergedDocument,
        summary
    });

    await interaction.reply(withSafeMentions({
        content:
            `Change summary for \`${String(editSession.originalDocument._id)}\`:\n${summary}` +
            (editSession.trimmedKeys.length
                ? `\n\nTrimmed fields were preserved unchanged: ${editSession.trimmedKeys.join(", ")}`
                : ""),
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(makeCustomId(FIND_EDIT_CONFIRM_PREFIX, confirmSessionId, "apply"))
                    .setLabel("Confirm")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(makeCustomId(FIND_EDIT_CONFIRM_PREFIX, confirmSessionId, "cancel"))
                    .setLabel("Cancel")
                    .setStyle(ButtonStyle.Secondary)
            )
        ],
        ephemeral: true
    }));

    deleteSession(sessionId);
}

async function handleEditConfirmationButton(interaction) {
    const [, sessionId, action] = parseCustomId(interaction.customId);
    const confirmSession = getSession(sessionId, "findEditConfirm");

    if (!confirmSession) {
        await interaction.reply(withSafeMentions({
            content: "That confirmation expired.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, confirmSession)) {
        await replyPrivately(interaction, "Only the original requester can confirm that edit.");
        return;
    }

    if (action === "cancel") {
        await interaction.update(withSafeMentions({
            content: "Edit cancelled.",
            components: []
        }));
        deleteSession(sessionId);
        return;
    }

    const database = await getDatabase(confirmSession.database);
    const documentId = EJSON.parse(confirmSession.idSource);
    await database.collection(confirmSession.collection).replaceOne(
        { _id: documentId },
        confirmSession.mergedDocument
    );

    await tryRefreshStoredFindMessage(confirmSession.resultSessionId);

    await interaction.update(withSafeMentions({
        content: `Document \`${String(documentId)}\` updated successfully.\n${confirmSession.summary}`,
        components: []
    }));

    deleteSession(sessionId);
}

async function handleFindDeleteModalSubmit(interaction) {
    const [, sessionId] = parseCustomId(interaction.customId);
    const deleteRequest = getSession(sessionId, "findDelete");

    if (!deleteRequest) {
        await interaction.reply(withSafeMentions({
            content: "That delete confirmation expired.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, deleteRequest)) {
        await replyPrivately(interaction, "Only the original requester can delete that document.");
        return;
    }

    const confirmation = interaction.fields.getTextInputValue("confirmation");
    if (confirmation !== "DELETE") {
        await interaction.reply(withSafeMentions({
            content: "Delete cancelled because the confirmation text did not match `DELETE`.",
            ephemeral: true
        }));
        deleteSession(sessionId);
        return;
    }

    const resultSession = getSession(deleteRequest.resultSessionId, "findResults");
    if (resultSession) {
        await deleteDocumentById(resultSession, deleteRequest.idSource);
        await tryRefreshStoredFindMessage(deleteRequest.resultSessionId);
    }

    await interaction.reply(withSafeMentions({
        content: `Deleted document \`${deleteRequest.idLabel}\`. Use Refresh if you were looking at an ephemeral result page.`,
        ephemeral: true
    }));

    deleteSession(sessionId);
}

async function refreshFindInteraction(interaction, sessionId, requestedPage, notice) {
    const session = getSession(sessionId, "findResults");
    if (!session) {
        await replyPrivately(interaction, "That find session expired. Run the query again.");
        return;
    }

    const { payload, nextSession } = await buildFindPayload(sessionId, session, requestedPage, notice);
    setSessionData(sessionId, nextSession);
    await interaction.update(payload);
}

async function buildFindPayload(sessionId, session, requestedPage, notice) {
    const {
        documents,
        page,
        pageCount,
        totalMatches,
        pageSize
    } = await fetchFindPage(session, requestedPage);

    const workingSession = {
        ...session,
        page,
        pageSize,
        items: {}
    };

    const headerLines = [
        "# Find Results",
        `- Collection: \`${session.database}.${session.collection}\``,
        `- Page ${page + 1}/${Math.max(pageCount, 1)} | ${documents.length} shown | ${totalMatches} matched`
    ];

    if (session.recentName) {
        headerLines.push(`- Recent: \`${session.recentName}\``);
    }

    if (notice) {
        headerLines.push(`- Notice: ${notice}`);
    }

    const container = new ContainerBuilder()
        .setAccentColor(getThemeGreen())
        .addTextDisplayComponents(createText(headerLines.join("\n")));

    if (!documents.length) {
        container
            .addSeparatorComponents(createSeparator())
            .addTextDisplayComponents(createText("No documents matched this page."));
    }
    else {
        const remainingBudget = Math.max(900, 3800 - headerLines.join("\n").length);
        const perDocumentBudget = Math.max(180, Math.floor(remainingBudget / documents.length) - 80);

        documents.forEach((document, index) => {
            const token = crypto.randomBytes(4).toString("hex");
            const idLabel = shorten(formatInlineMongoValue(document._id), 60);
            workingSession.items[token] = {
                idSource: toExtendedJson(document._id, false),
                idLabel
            };

            const preview = makeDocumentPreview(document, perDocumentBudget);
            const label = [
                `## ${page * pageSize + index + 1}. \`${idLabel}\``,
                "```json",
                preview,
                "```"
            ].join("\n");

            container
                .addSeparatorComponents(createSeparator())
                .addTextDisplayComponents(createText(label))
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(FIND_VIEW_PREFIX, sessionId, "edit", token))
                            .setLabel("Edit")
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(FIND_VIEW_PREFIX, sessionId, "download", token))
                            .setLabel("Download")
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(FIND_VIEW_PREFIX, sessionId, "delete", token))
                            .setLabel("Delete")
                            .setStyle(ButtonStyle.Danger)
                    )
                );
        });
    }

    return {
        payload: createComponentsV2Payload({
            components: [
                container,
                createPagerRow({
                    previousId: makeCustomId(FIND_VIEW_PREFIX, sessionId, "page", "prev"),
                    nextId: makeCustomId(FIND_VIEW_PREFIX, sessionId, "page", "next"),
                    refreshId: makeCustomId(FIND_VIEW_PREFIX, sessionId, "refresh"),
                    page,
                    pageCount
                })
            ]
        }),
        nextSession: workingSession
    };
}

async function fetchFindPage(session, requestedPage) {
    const database = await getDatabase(session.database);
    const collection = database.collection(session.collection);
    const options = normalizeFindOptions(session.parsed.options);

    let pageSize = session.pageSize;
    if (!pageSize) {
        const sample = await applyFindCursorOptions(
            collection.find(session.parsed.filter, {
                projection: session.parsed.projection
            }),
            session.parsed,
            options
        )
            .skip(options.skip)
            .limit(1)
            .next();

        pageSize = Math.min(pickResultPageSize(sample || {}), MAX_FIND_RESULTS_PER_PAGE);
    }

    const counted = await collection.countDocuments(session.parsed.filter);
    const visibleAfterSkip = Math.max(0, counted - options.skip);
    const cappedTotal = options.limit == null ? visibleAfterSkip : Math.min(visibleAfterSkip, options.limit);
    const pageCount = Math.max(1, Math.ceil(Math.max(cappedTotal, 1) / pageSize));
    const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
    const startIndex = page * pageSize;
    const remaining = Math.max(0, cappedTotal - startIndex);
    const currentPageLimit = Math.min(pageSize, remaining || pageSize);

    const documents = remaining === 0 && cappedTotal !== 0
        ? []
        : await applyFindCursorOptions(
            collection.find(session.parsed.filter, {
                projection: session.parsed.projection
            }),
            session.parsed,
            options
        )
            .skip(options.skip + startIndex)
            .limit(currentPageLimit)
            .toArray();

    return {
        documents,
        page,
        pageCount,
        totalMatches: cappedTotal,
        pageSize
    };
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

async function getFullDocumentForItem(session, itemToken) {
    const item = session.items?.[itemToken];
    if (!item) {
        throw new Error("That document is no longer on the current page.");
    }

    const database = await getDatabase(session.database);
    const documentId = EJSON.parse(item.idSource);
    const document = await database.collection(session.collection).findOne({ _id: documentId });

    if (!document) {
        throw new Error("The requested document no longer exists.");
    }

    return document;
}

async function deleteDocumentById(session, idSource) {
    const database = await getDatabase(session.database);
    const documentId = EJSON.parse(idSource);
    await database.collection(session.collection).deleteOne({ _id: documentId });
}

async function tryRefreshStoredFindMessage(sessionId) {
    const session = getSession(sessionId, "findResults");
    if (!session?.messageRef) {
        return false;
    }

    try {
        const channel = await client.channels.fetch(session.messageRef.channelId);
        if (!channel?.isTextBased?.()) {
            return false;
        }

        const message = await channel.messages.fetch(session.messageRef.messageId);
        const { payload, nextSession } = await buildFindPayload(sessionId, session, session.page);
        nextSession.messageRef = session.messageRef;
        setSessionData(sessionId, nextSession);
        await message.edit(payload);
        return true;
    }
    catch {
        return false;
    }
}

async function buildQuickFilterSuggestions(interaction) {
    const databaseName = interaction.options.getString("database");
    const collectionName = interaction.options.getString("collection");
    const focusedValue = interaction.options.getFocused();

    if (!databaseName || !collectionName) {
        return [];
    }

    const fieldPaths = await sampleFieldPaths(databaseName, collectionName);
    if (!fieldPaths.length) {
        return [];
    }

    const suggestions = [];
    const trimmed = String(focusedValue || "").trim();
    const keyPrefix = extractQuickFieldPrefix(focusedValue);

    if (keyPrefix != null) {
        for (const fieldPath of fieldPaths) {
            if (!fieldPath.toLowerCase().startsWith(keyPrefix.toLowerCase())) {
                continue;
            }

            const completion = applyQuickFieldCompletion(focusedValue, fieldPath, keyPrefix);
            if (completion && completion.length <= 100) {
                suggestions.push(completion);
            }
        }
    }

    if (!suggestions.length && !trimmed) {
        suggestions.push(
            ...fieldPaths
                .slice(0, 10)
                .map(fieldPath => `{ "${fieldPath}": `)
        );
    }

    return [...new Set(suggestions)].slice(0, 25);
}

async function sampleFieldPaths(databaseName, collectionName) {
    const database = await getDatabase(databaseName);
    const documents = await database.collection(collectionName)
        .find({}, { projection: { _id: 0 } })
        .limit(QUICK_FIELD_SAMPLE_LIMIT)
        .toArray();

    const fieldPaths = new Set();
    for (const document of documents) {
        collectFieldPaths(document, "", 0, fieldPaths);
    }

    return [...fieldPaths].sort((left, right) => left.localeCompare(right));
}

function collectFieldPaths(value, prefix, depth, fieldPaths) {
    if (!value || typeof value !== "object" || depth > QUICK_FIELD_DEPTH) {
        return;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            collectFieldPaths(entry, prefix, depth + 1, fieldPaths);
        }
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        fieldPaths.add(nextPrefix);

        if (child && typeof child === "object" && !Object.keys(child).every(entryKey => entryKey.startsWith("$"))) {
            collectFieldPaths(child, nextPrefix, depth + 1, fieldPaths);
        }
    }
}

function extractQuickFieldPrefix(source) {
    const text = String(source || "");
    const quotedMatch = text.match(/(?:^|[{,])\s*"([^"]*)$/);
    if (quotedMatch) {
        return quotedMatch[1];
    }

    const bareMatch = text.match(/(?:^|[{,])\s*([A-Za-z0-9_.-]*)$/);
    if (bareMatch) {
        return bareMatch[1];
    }

    return null;
}

function applyQuickFieldCompletion(source, fieldPath, keyPrefix) {
    const text = String(source || "");
    const replacement = `"${fieldPath}": `;
    const quotedIndex = text.lastIndexOf(`"${keyPrefix}`);
    if (quotedIndex >= 0) {
        return `${text.slice(0, quotedIndex)}${replacement}`;
    }

    const bareMatch = text.match(/^(.*?)([A-Za-z0-9_.-]*)$/);
    if (bareMatch) {
        return `${bareMatch[1]}${replacement}`;
    }

    return `{ ${replacement}`;
}

function canUseSession(interaction, session) {
    return session.ownerId === interaction.user.id || isDevAdmin(interaction.user.id);
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

function formatInlineMongoValue(value) {
    return makeDocumentPreview(value, 120).replace(/\s+/g, " ").trim();
}

function sanitizeFileName(value) {
    return value.replaceAll(/[^a-z0-9_-]/gi, "_");
}
