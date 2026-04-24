const crypto = require("node:crypto");
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    FileUploadBuilder,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");
const { isDevAdmin, replyPrivately } = require("../lib/access");
const { makeCustomId, parseCustomId } = require("../lib/customIds");
const {
    createComponentsV2Payload,
    createStatusEmbed,
    createSeparator,
    createText,
    getThemeGreen,
    shorten,
    addPrivateOption,
    withSafeMentions
} = require("../lib/discordViews");
const { makeDocumentPreview, pickResultPageSize } = require("../lib/documentTools");
const { respond } = require("../lib/interactions");
const { listCollectionNames, listDatabaseNames } = require("../lib/mongoAdmin");
const { parseMongoExpression } = require("../lib/mongoExpression");
const { EJSON, getDatabase, toExtendedJson } = require("../lib/mongo");
const { createSession, deleteSession, getSession, setSessionData } = require("../lib/sessions");
const { deleteSavedPipeline, getSavedPipeline, listSavedPipelines, upsertSavedPipeline } = require("../lib/state");

const AGG_PREFIX = "agg";
const AGG_STAGE_MODAL_PREFIX = "aggStageModal";
const AGG_MOVE_MODAL_PREFIX = "aggMoveModal";
const AGG_PIPE_MODAL_PREFIX = "aggPipeModal";

const DISCORD_COMPONENT_LIMIT = 40;
const EDITOR_STATIC_COMPONENTS = 11;
const EDITOR_COMPONENTS_PER_STAGE = 8;
const RESULT_STATIC_COMPONENTS = 7;
const RESULT_COMPONENTS_PER_DOCUMENT = 4;

const EDITOR_PAGE_SIZE = Math.max(1, Math.floor((DISCORD_COMPONENT_LIMIT - EDITOR_STATIC_COMPONENTS) / EDITOR_COMPONENTS_PER_STAGE));
const MAX_RESULTS_PER_PAGE = Math.max(1, Math.floor((DISCORD_COMPONENT_LIMIT - RESULT_STATIC_COMPONENTS) / RESULT_COMPONENTS_PER_DOCUMENT));

module.exports = {
    data: {
        deferReply: false,
        command: new SlashCommandBuilder()
            .setName("aggregation")
            .setDescription("Create, edit, run, import, or delete saved aggregation pipelines")
            .addSubcommand(subcommand =>
                subcommand
                    .setName("create")
                    .setDescription("Create a new saved pipeline and open its editor")
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
                            .setName("name")
                            .setDescription("Saved pipeline name")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("edit")
                    .setDescription("Open a saved pipeline editor")
                    .addStringOption(option =>
                        option
                            .setName("name")
                            .setDescription("Saved pipeline name")
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("run")
                    .setDescription("Run a saved pipeline immediately")
                    .addStringOption(option =>
                        option
                            .setName("name")
                            .setDescription("Saved pipeline name")
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("delete")
                    .setDescription("Delete a saved pipeline")
                    .addStringOption(option =>
                        option
                            .setName("name")
                            .setDescription("Saved pipeline name")
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("import")
                    .setDescription("Create or replace a saved pipeline from a modal import flow")
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
                            .setName("name")
                            .setDescription("Saved pipeline name")
                            .setRequired(true)
                    )
                    .addBooleanOption(addPrivateOption)
            )
    },

    subscribedCustomIds: [
        /^agg\|/,
        /^aggStageModal\|/,
        /^aggMoveModal\|/,
        /^aggPipeModal\|/
    ],

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand();

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

        if (["edit", "run", "delete"].includes(subcommand) && focused.name === "name") {
            const pipelines = await listSavedPipelines(focused.value);
            await interaction.respond(
                pipelines.map(entry => ({
                    name: shorten(`${entry.name} (${entry.database}.${entry.collection})`, 100),
                    value: entry.name
                }))
            );
            return;
        }

        await interaction.respond([]);
    },

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const isPrivate = interaction.options.getBoolean("private") ?? false;

        if (subcommand === "create") {
            const name = interaction.options.getString("name", true);
            const session = await createOrUpdatePipeline(interaction.user.id, {
                name,
                database: interaction.options.getString("database", true),
                collection: interaction.options.getString("collection", true),
                stages: []
            }, isPrivate);

            await sendAggregationView(interaction, session);
            return;
        }

        if (subcommand === "edit" || subcommand === "run") {
            const name = interaction.options.getString("name", true);
            const saved = await getSavedPipeline(name);
            if (!saved) {
                await interaction.reply(withSafeMentions({
                    content: `No saved pipeline named "${name}" was found.`,
                    ephemeral: true
                }));
                return;
            }

            const session = createAggregationSession(saved, interaction.user.id, isPrivate, subcommand === "run" ? "results" : "editor");
            await sendAggregationView(interaction, session);
            return;
        }

        if (subcommand === "delete") {
            const name = interaction.options.getString("name", true);
            const result = await deleteSavedPipeline(name);
            await respond(interaction, {
                embeds: [
                    createStatusEmbed({
                        title: "Saved Pipeline",
                        description: result.deletedCount
                            ? `Deleted saved pipeline \`${name}\`.`
                            : `No saved pipeline named \`${name}\` existed.`
                    })
                ],
                ephemeral: isPrivate
            });
            return;
        }

        if (subcommand === "import") {
            const modalSessionId = createSession("aggPipelineImport", {
                ownerId: interaction.user.id,
                database: interaction.options.getString("database", true),
                collection: interaction.options.getString("collection", true),
                name: interaction.options.getString("name", true),
                private: isPrivate,
                mode: "command"
            });

            await interaction.showModal(buildPipelineImportModal(modalSessionId, {
                name: interaction.options.getString("name", true),
                stages: []
            }));
        }
    },

    async onbutton(interaction) {
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith(`${AGG_STAGE_MODAL_PREFIX}|`)) {
                await handleStageModalSubmit(interaction);
                return;
            }

            if (interaction.customId.startsWith(`${AGG_MOVE_MODAL_PREFIX}|`)) {
                await handleMoveModalSubmit(interaction);
                return;
            }

            if (interaction.customId.startsWith(`${AGG_PIPE_MODAL_PREFIX}|`)) {
                await handlePipelineImportModalSubmit(interaction);
            }
            return;
        }

        if (!interaction.isButton() || !interaction.customId.startsWith(`${AGG_PREFIX}|`)) {
            return;
        }

        const [, sessionId, action, value] = parseCustomId(interaction.customId);
        const session = getSession(sessionId, "aggregation");

        if (!session) {
            await replyPrivately(interaction, "That aggregation session expired. Open it again.");
            return;
        }

        if (!canUseSession(interaction, session)) {
            await replyPrivately(interaction, "Only the original requester can use these aggregation controls.");
            return;
        }

        if (action === "page") {
            if (session.mode === "editor") {
                session.editorPage = Math.max(0, session.editorPage + (value === "next" ? 1 : -1));
            }
            else {
                session.resultPage = Math.max(0, session.resultPage + (value === "next" ? 1 : -1));
            }
            await refreshAggregationInteraction(interaction, sessionId, session);
            return;
        }

        if (action === "back") {
            session.mode = "editor";
            await refreshAggregationInteraction(interaction, sessionId, session);
            return;
        }

        if (action === "run") {
            session.mode = "results";
            session.resultPage = 0;
            await refreshAggregationInteraction(interaction, sessionId, session);
            return;
        }

        if (action === "add") {
            const modalSessionId = createSession("aggStageEditor", {
                ownerId: interaction.user.id,
                aggregationSessionId: sessionId,
                mode: "add",
                index: session.stages.length
            });

            await interaction.showModal(buildStageModal(modalSessionId, "Add stage", "{\n  \"$match\": {}\n}"));
            return;
        }

        if (action === "importpipe") {
            const modalSessionId = createSession("aggPipelineImport", {
                ownerId: interaction.user.id,
                aggregationSessionId: sessionId,
                mode: "editor"
            });
            await interaction.showModal(buildPipelineImportModal(modalSessionId, session));
            return;
        }

        if (action === "exportpipe") {
            const file = new AttachmentBuilder(
                Buffer.from(formatPipelineForExport(session.stages), "utf8"),
                { name: `${session.name}-pipeline.json` }
            );
            await interaction.reply(withSafeMentions({
                content: `Exported pipeline \`${session.name}\`.`,
                files: [file],
                ephemeral: true
            }));
            return;
        }

        if (action === "resultDownload") {
            const item = session.resultItems?.[value];
            if (!item) {
                await replyPrivately(interaction, "That result row is no longer cached. Rerun the pipeline.");
                return;
            }

            const file = new AttachmentBuilder(
                Buffer.from(toExtendedJson(item.document, true), "utf8"),
                { name: `${session.name}-result-${value}.json` }
            );
            await interaction.reply(withSafeMentions({
                content: `Exported aggregation result ${item.label}.`,
                files: [file],
                ephemeral: true
            }));
            return;
        }

        const index = Number(value);
        if (!Number.isInteger(index) || index < 0 || index >= session.stages.length) {
            await replyPrivately(interaction, "That stage reference is out of date. Refresh the editor.");
            return;
        }

        if (action === "toggle") {
            session.stages[index].enabled = !session.stages[index].enabled;
            await persistAggregationSession(interaction.user.id, session);
            await refreshAggregationInteraction(interaction, sessionId, session);
            return;
        }

        if (action === "move") {
            const modalSessionId = createSession("aggMoveEditor", {
                ownerId: interaction.user.id,
                aggregationSessionId: sessionId,
                index
            });
            await interaction.showModal(buildMoveModal(modalSessionId, index));
            return;
        }

        if (action === "edit" || action === "importstage") {
            const stage = session.stages[index];
            if (action === "edit" && stage.source.length > 4000) {
                await replyPrivately(
                    interaction,
                    "That stage is too large for a Discord modal. Export it, edit it locally, then re-import it."
                );
                return;
            }
            const modalSessionId = createSession("aggStageEditor", {
                ownerId: interaction.user.id,
                aggregationSessionId: sessionId,
                mode: action === "edit" ? "edit" : "import",
                index
            });

            await interaction.showModal(
                buildStageModal(
                    modalSessionId,
                    action === "edit" ? `Edit stage ${index + 1}` : `Import stage ${index + 1}`,
                    action === "edit" ? stage.source : ""
                )
            );
            return;
        }

        if (action === "exportstage") {
            const stage = session.stages[index];
            const file = new AttachmentBuilder(
                Buffer.from(stage.source, "utf8"),
                { name: `${session.name}-stage-${index + 1}.json` }
            );
            await interaction.reply(withSafeMentions({
                content: `Exported stage ${index + 1}.`,
                files: [file],
                ephemeral: true
            }));
        }
    }
};

function createAggregationSession(saved, ownerId, isPrivate, mode = "editor") {
    const stages = Array.isArray(saved.stages) && saved.stages.length
        ? saved.stages.map(stage => ({
            source: stage.source,
            enabled: stage.enabled !== false
        }))
        : parsePipelineStages(saved.pipelineSource || "[]");

    return {
        ownerId,
        private: isPrivate,
        name: saved.name,
        database: saved.database,
        collection: saved.collection,
        stages,
        mode,
        editorPage: 0,
        resultPage: 0,
        resultPageSize: null,
        resultItems: {},
        messageRef: null,
        lastResultNotice: null
    };
}

async function createOrUpdatePipeline(userId, payload, isPrivate) {
    const normalizedStages = payload.stages.map(stage => ({
        source: stage.source,
        enabled: stage.enabled !== false
    }));

    await upsertSavedPipeline(payload.name, {
        name: payload.name,
        database: payload.database,
        collection: payload.collection,
        pipelineSource: formatPipelineForExport(normalizedStages),
        stages: normalizedStages
    }, userId);

    return {
        ownerId: userId,
        private: isPrivate,
        name: payload.name,
        database: payload.database,
        collection: payload.collection,
        stages: normalizedStages,
        mode: "editor",
        editorPage: 0,
        resultPage: 0,
        resultPageSize: null,
        resultItems: {},
        messageRef: null,
        lastResultNotice: null
    };
}

async function sendAggregationView(interaction, session, notice) {
    if (notice) {
        session.lastResultNotice = notice;
    }

    const sessionId = createSession("aggregation", session);
    const { payload, nextSession } = await buildAggregationPayload(sessionId, session);
    setSessionData(sessionId, nextSession);

    await interaction.reply(session.private
        ? { ...payload, flags: payload.flags | MessageFlags.Ephemeral }
        : payload);

    if (!session.private) {
        const message = await interaction.fetchReply();
        nextSession.messageRef = {
            channelId: message.channelId,
            messageId: message.id
        };
        setSessionData(sessionId, nextSession);
    }
}

async function refreshAggregationInteraction(interaction, sessionId, session) {
    const { payload, nextSession } = await buildAggregationPayload(sessionId, session);
    setSessionData(sessionId, nextSession);
    await interaction.update(payload);
}

async function buildAggregationPayload(sessionId, session) {
    const nextSession = {
        ...session,
        resultItems: {}
    };

    if (session.mode === "results") {
        return buildAggregationResultsPayload(sessionId, nextSession);
    }

    return buildAggregationEditorPayload(sessionId, nextSession);
}

async function buildAggregationEditorPayload(sessionId, session) {
    const pageCount = Math.max(1, Math.ceil(Math.max(session.stages.length, 1) / EDITOR_PAGE_SIZE));
    session.editorPage = Math.min(session.editorPage, pageCount - 1);
    const startIndex = session.editorPage * EDITOR_PAGE_SIZE;
    const pageStages = session.stages.slice(startIndex, startIndex + EDITOR_PAGE_SIZE);

    const header = [
        "# Aggregation Editor",
        `- Pipeline: \`${session.name}\``,
        `- Collection: \`${session.database}.${session.collection}\``,
        `- Stages: ${session.stages.length} total, ${session.stages.filter(stage => stage.enabled !== false).length} enabled`
    ];

    if (session.lastResultNotice) {
        header.push(`- Last Change: ${session.lastResultNotice}`);
        session.lastResultNotice = null;
    }

    const container = new ContainerBuilder()
        .setAccentColor(getThemeGreen())
        .addTextDisplayComponents(createText(header.join("\n")))
        .addSeparatorComponents(createSeparator())
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "add"))
                    .setLabel("Add Stage")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "importpipe"))
                    .setLabel("Import Pipeline")
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "exportpipe"))
                    .setLabel("Export Pipeline")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    if (!pageStages.length) {
        container
            .addSeparatorComponents(createSeparator())
            .addTextDisplayComponents(createText("No stages yet. Add one, or import a pipeline array."));
    }
    else {
        const remainingBudget = 3400;
        const perStageBudget = Math.max(220, Math.floor(remainingBudget / pageStages.length) - 80);

        pageStages.forEach((stage, pageIndex) => {
            const absoluteIndex = startIndex + pageIndex;
            const preview = makeDocumentPreview(parseStageSafely(stage.source), perStageBudget);
            const stageName = getStageName(stage.source);
            const title = [
                `## Stage ${absoluteIndex + 1}: \`${stageName}\` ${stage.enabled === false ? "(disabled)" : ""}`,
                "```json",
                preview,
                "```"
            ].join("\n");

            container
                .addSeparatorComponents(createSeparator())
                .addTextDisplayComponents(createText(title))
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "edit", absoluteIndex))
                            .setLabel("Edit")
                            .setStyle(stage.enabled === false ? ButtonStyle.Danger : ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "toggle", absoluteIndex))
                            .setLabel(stage.enabled === false ? "Enable" : "Disable")
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "move", absoluteIndex))
                            .setLabel("Move")
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "importstage", absoluteIndex))
                            .setLabel("Import")
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "exportstage", absoluteIndex))
                            .setLabel("Export")
                            .setStyle(ButtonStyle.Secondary)
                    )
                );
        });
    }

    return {
        payload: createComponentsV2Payload({
            components: [
                container,
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "page", "prev"))
                        .setLabel("Prev")
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(session.editorPage <= 0),
                    new ButtonBuilder()
                        .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "run"))
                        .setLabel("Run")
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "page", "next"))
                        .setLabel("Next")
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(session.editorPage >= pageCount - 1)
                )
            ]
        }),
        nextSession: session
    };
}

async function buildAggregationResultsPayload(sessionId, session) {
    const result = await fetchAggregationResultsPage(session);
    session.resultPage = result.page;
    session.resultPageSize = result.pageSize;

    const header = [
        "# Aggregation Results",
        `- Pipeline: \`${session.name}\``,
        `- Collection: \`${session.database}.${session.collection}\``,
        `- Page: ${result.page + 1}${result.hasNext ? " +" : ""}`,
        `- Enabled stages: ${session.stages.filter(stage => stage.enabled !== false).length}`
    ];

    if (session.lastResultNotice) {
        header.push(`- Last Change: ${session.lastResultNotice}`);
        session.lastResultNotice = null;
    }

    const container = new ContainerBuilder()
        .setAccentColor(getThemeGreen())
        .addTextDisplayComponents(createText(header.join("\n")));

    if (!result.documents.length) {
        container
            .addSeparatorComponents(createSeparator())
            .addTextDisplayComponents(createText("No results came back from the current pipeline page."));
    }
    else {
        const remainingBudget = Math.max(900, 3600 - header.join("\n").length);
        const perResultBudget = Math.max(180, Math.floor(remainingBudget / result.documents.length) - 90);

        result.documents.forEach((document, index) => {
            const token = crypto.randomBytes(4).toString("hex");
            const label = `${result.page * result.pageSize + index + 1}`;
            session.resultItems[token] = {
                label,
                document
            };

            const preview = makeDocumentPreview(document, perResultBudget);
            container
                .addSeparatorComponents(createSeparator())
                .addTextDisplayComponents(createText([
                    `## Result ${label}`,
                    "```json",
                    preview,
                    "```"
                ].join("\n")))
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "resultDownload", token))
                            .setLabel("Download")
                            .setStyle(ButtonStyle.Secondary)
                    )
                );
        });
    }

    return {
        payload: createComponentsV2Payload({
            components: [
                container,
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "page", "prev"))
                        .setLabel("Prev")
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(result.page <= 0),
                    new ButtonBuilder()
                        .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "page", "next"))
                        .setLabel("Next")
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(!result.hasNext)
                ),
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "back"))
                        .setLabel("Edit")
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(makeCustomId(AGG_PREFIX, sessionId, "run"))
                        .setLabel("Rerun")
                        .setStyle(ButtonStyle.Success)
                )
            ]
        }),
        nextSession: session
    };
}

async function fetchAggregationResultsPage(session) {
    const database = await getDatabase(session.database);
    const collection = database.collection(session.collection);
    const pipeline = session.stages
        .filter(stage => stage.enabled !== false)
        .map((stage, index) => parseMongoExpression(stage.source, {
            expect: "object",
            label: `stage ${index + 1}`
        }));

    let pageSize = session.resultPageSize;
    if (!pageSize) {
        // Use a dedicated pipeline for sampling so limit() never mutates the
        // actual pipeline used for page results.
        const samplePipeline = [...pipeline, { $limit: 1 }];
        const sample = await collection.aggregate(samplePipeline).next();
        pageSize = Math.max(1, Math.min(pickResultPageSize(sample || {}), MAX_RESULTS_PER_PAGE));
    }

    const page = Math.max(0, session.resultPage || 0);
    const pagePipeline = [...pipeline];
    if (page > 0) {
        pagePipeline.push({ $skip: page * pageSize });
    }
    pagePipeline.push({ $limit: pageSize + 1 });

    const results = await collection.aggregate(pagePipeline).toArray();

    const hasNext = results.length > pageSize;
    if (hasNext) {
        results.pop();
    }

    if (!results.length && page > 0) {
        session.resultPage = page - 1;
        return fetchAggregationResultsPage(session);
    }

    return {
        documents: results,
        page,
        pageSize,
        hasNext
    };
}

function buildStageModal(sessionId, title, value) {
    const trimmed = String(value).slice(0, 4000);
    return new ModalBuilder()
        .setCustomId(makeCustomId(AGG_STAGE_MODAL_PREFIX, sessionId))
        .setTitle(shorten(title, 45))
        .addLabelComponents(
            createModalTextInputLabel({
                customId: "stage",
                label: "Stage JSON or upload a file below",
                style: TextInputStyle.Paragraph,
                required: false,
                value: trimmed
            }),
            createModalFileUploadLabel({
                customId: "stage_file",
                label: "Stage JSON file (optional)"
            })
        );
}

function buildMoveModal(sessionId, index) {
    return new ModalBuilder()
        .setCustomId(makeCustomId(AGG_MOVE_MODAL_PREFIX, sessionId))
        .setTitle("Move stage")
        .addLabelComponents(
            createModalTextInputLabel({
                customId: "target",
                label: `Move stage ${index + 1} to position`,
                style: TextInputStyle.Short,
                required: true,
                value: String(index + 1)
            })
        );
}

function buildPipelineImportModal(sessionId, session) {
    return new ModalBuilder()
        .setCustomId(makeCustomId(AGG_PIPE_MODAL_PREFIX, sessionId))
        .setTitle(shorten(`Import ${session.name}`, 45))
        .addLabelComponents(
            createModalTextInputLabel({
                customId: "pipeline",
                label: "Pipeline JSON or upload a file below",
                style: TextInputStyle.Paragraph,
                required: false,
                value: formatPipelineForExport(session.stages).slice(0, 4000)
            }),
            createModalFileUploadLabel({
                customId: "pipeline_file",
                label: "Pipeline JSON file (optional)"
            })
        );
}

async function handleStageModalSubmit(interaction) {
    const [, modalSessionId] = parseCustomId(interaction.customId);
    const modalSession = getSession(modalSessionId, "aggStageEditor");

    if (!modalSession) {
        await interaction.reply(withSafeMentions({
            content: "That stage editor expired.",
            ephemeral: true
        }));
        return;
    }

    const aggregationSession = getSession(modalSession.aggregationSessionId, "aggregation");
    if (!aggregationSession) {
        await interaction.reply(withSafeMentions({
            content: "The parent aggregation editor expired.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, modalSession) || !canUseSession(interaction, aggregationSession)) {
        await replyPrivately(interaction, "Only the original requester can submit that stage edit.");
        return;
    }

    const stageSource = await getModalSourceText(interaction, "stage", "stage_file", "stage JSON");
    const stage = parseMongoExpression(stageSource, {
        expect: "object",
        label: "aggregation stage"
    });
    const serialized = toExtendedJson(stage, true);

    if (modalSession.mode === "add") {
        aggregationSession.stages.push({
            source: serialized,
            enabled: true
        });
        aggregationSession.editorPage = Math.floor((aggregationSession.stages.length - 1) / EDITOR_PAGE_SIZE);
    }
    else {
        aggregationSession.stages[modalSession.index] = {
            ...aggregationSession.stages[modalSession.index],
            source: serialized,
            enabled: aggregationSession.stages[modalSession.index].enabled !== false
        };
    }

    await persistAggregationSession(interaction.user.id, aggregationSession);
    aggregationSession.mode = "editor";
    aggregationSession.lastResultNotice = modalSession.mode === "add"
        ? "Added a new stage."
        : `Updated stage ${modalSession.index + 1}.`;

    const { payload, nextSession } = await buildAggregationPayload(modalSession.aggregationSessionId, aggregationSession);
    setSessionData(modalSession.aggregationSessionId, nextSession);
    await interaction.update(payload);
    deleteSession(modalSessionId);
}

async function handleMoveModalSubmit(interaction) {
    const [, modalSessionId] = parseCustomId(interaction.customId);
    const modalSession = getSession(modalSessionId, "aggMoveEditor");

    if (!modalSession) {
        await interaction.reply(withSafeMentions({
            content: "That move dialog expired.",
            ephemeral: true
        }));
        return;
    }

    const aggregationSession = getSession(modalSession.aggregationSessionId, "aggregation");
    if (!aggregationSession) {
        await interaction.reply(withSafeMentions({
            content: "The parent aggregation editor expired.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, modalSession) || !canUseSession(interaction, aggregationSession)) {
        await replyPrivately(interaction, "Only the original requester can move that stage.");
        return;
    }

    const target = Number(interaction.fields.getTextInputValue("target"));
    if (!Number.isInteger(target) || target < 1 || target > aggregationSession.stages.length) {
        throw new Error(`Target position must be between 1 and ${aggregationSession.stages.length}.`);
    }

    const [stage] = aggregationSession.stages.splice(modalSession.index, 1);
    aggregationSession.stages.splice(target - 1, 0, stage);
    aggregationSession.editorPage = Math.floor((target - 1) / EDITOR_PAGE_SIZE);

    await persistAggregationSession(interaction.user.id, aggregationSession);

    const { payload, nextSession } = await buildAggregationPayload(modalSession.aggregationSessionId, aggregationSession);
    setSessionData(modalSession.aggregationSessionId, nextSession);
    await interaction.update(payload);
    deleteSession(modalSessionId);
}

async function handlePipelineImportModalSubmit(interaction) {
    const [, modalSessionId] = parseCustomId(interaction.customId);
    const modalSession = getSession(modalSessionId, "aggPipelineImport");

    if (!modalSession) {
        await interaction.reply(withSafeMentions({
            content: "That pipeline import dialog expired.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, modalSession)) {
        await replyPrivately(interaction, "Only the original requester can import that pipeline.");
        return;
    }

    const sourceText = await getModalSourceText(interaction, "pipeline", "pipeline_file", "pipeline JSON");

    if (modalSession.mode === "command") {
        const session = await createOrUpdatePipeline(interaction.user.id, {
            name: modalSession.name,
            database: modalSession.database,
            collection: modalSession.collection,
            stages: parsePipelineStages(sourceText)
        }, modalSession.private);

        deleteSession(modalSessionId);
        await sendAggregationView(interaction, session, "Imported pipeline JSON.");
        return;
    }

    const aggregationSession = getSession(modalSession.aggregationSessionId, "aggregation");
    if (!aggregationSession) {
        await interaction.reply(withSafeMentions({
            content: "The parent aggregation editor expired.",
            ephemeral: true
        }));
        return;
    }

    if (!canUseSession(interaction, aggregationSession)) {
        await replyPrivately(interaction, "Only the original requester can import that pipeline.");
        return;
    }

    aggregationSession.stages = parsePipelineStages(sourceText);
    aggregationSession.editorPage = 0;
    aggregationSession.mode = "editor";
    aggregationSession.lastResultNotice = "Imported pipeline JSON into the editor.";

    await persistAggregationSession(interaction.user.id, aggregationSession);
    const { payload, nextSession } = await buildAggregationPayload(modalSession.aggregationSessionId, aggregationSession);
    setSessionData(modalSession.aggregationSessionId, nextSession);
    await interaction.update(payload);
    deleteSession(modalSessionId);
}

function parsePipelineStages(sourceText) {
    const pipeline = parseMongoExpression(sourceText, {
        expect: "array",
        label: "aggregation pipeline"
    });

    return pipeline.map(stage => ({
        source: toExtendedJson(stage, true),
        enabled: true
    }));
}

function parseStageSafely(source) {
    try {
        return parseMongoExpression(source, {
            expect: "object",
            label: "stage"
        });
    }
    catch {
        return { invalidStage: source };
    }
}

function getStageName(source) {
    try {
        const stage = parseStageSafely(source);
        return Object.keys(stage)[0] || "stage";
    }
    catch {
        return "stage";
    }
}

function formatPipelineForExport(stages) {
    const lines = ["["];

    for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        const parsedStage = parseStageSafely(stage.source);
        const formattedStage = formatStageForExport(parsedStage).split("\n");
        const hasNextEnabled = stages.slice(index + 1).some(nextStage => nextStage.enabled !== false);

        if (stage.enabled === false) {
            formattedStage.forEach((line, lineIndex) => {
                const suffix = lineIndex === formattedStage.length - 1 && hasNextEnabled ? "," : "";
                lines.push(`  // ${line}${suffix}`);
            });
            continue;
        }

        formattedStage.forEach((line, lineIndex) => {
            const suffix = lineIndex === formattedStage.length - 1 && hasNextEnabled ? "," : "";
            lines.push(`  ${line}${suffix}`);
        });
    }

    lines.push("]");
    return lines.join("\n");
}

function formatStageForExport(stage) {
    const entries = Object.entries(stage || {});
    if (entries.length === 1) {
        const [key, value] = entries[0];
        if (key.startsWith("$") && (value === null || typeof value !== "object")) {
            return `{ ${JSON.stringify(key)}: ${toExtendedJson(value, true)} }`;
        }
    }

    return toExtendedJson(stage, true);
}

async function persistAggregationSession(userId, session) {
    await upsertSavedPipeline(session.name, {
        name: session.name,
        database: session.database,
        collection: session.collection,
        pipelineSource: formatPipelineForExport(session.stages),
        stages: session.stages
    }, userId);
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

function createModalFileUploadLabel({
    customId,
    label
}) {
    return new LabelBuilder()
        .setLabel(shorten(label, 45))
        .setFileUploadComponent(
            new FileUploadBuilder()
                .setCustomId(customId)
                .setRequired(false)
                .setMinValues(0)
                .setMaxValues(1)
        );
}

async function getModalSourceText(interaction, textFieldId, uploadFieldId, label) {
    let uploadedFiles = null;
    try {
        uploadedFiles = interaction.fields.getUploadedFiles(uploadFieldId);
    }
    catch {
        uploadedFiles = null;
    }

    if (uploadedFiles && uploadedFiles.size) {
        const attachment = uploadedFiles.first();
        const response = await fetch(attachment.url);
        if (!response.ok) {
            throw new Error(`Failed to download uploaded ${label} file.`);
        }

        const source = await response.text();
        if (source.trim()) {
            return source;
        }
    }

    let textValue = "";
    try {
        textValue = interaction.fields.getTextInputValue(textFieldId) || "";
    }
    catch {
        textValue = "";
    }

    textValue = textValue.trim();
    if (textValue) {
        return textValue;
    }

    throw new Error(`Provide ${label} in the text field or upload a file.`);
}
