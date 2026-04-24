const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    EmbedBuilder,
    MessageFlags,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder
} = require("discord.js");

function addPrivateOption(option) {
    return option
        .setName("private")
        .setDescription("Make the response visible only to you")
        .setRequired(false);
}

function getThemeGreen() {
    return global.THEME_GREEN || 0xb7e4c7;
}

function withSafeMentions(payload = {}) {
    if (!payload || typeof payload !== "object") {
        return payload;
    }

    return {
        ...payload,
        allowedMentions: payload.allowedMentions || { parse: [] }
    };
}

function createComponentsV2Payload({ components, files, allowedMentions, ephemeral = false }) {
    return withSafeMentions({
        components,
        files,
        allowedMentions,
        flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0)
    });
}

function createSeparator(spacing = SeparatorSpacingSize.Small, divider = true) {
    return new SeparatorBuilder()
        .setSpacing(spacing)
        .setDivider(divider);
}

function createText(content) {
    return new TextDisplayBuilder()
        .setContent(content);
}

function createContainer({ title, bodyLines = [], accentColor = getThemeGreen() }) {
    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(createText(title));

    for (const line of bodyLines) {
        container
            .addSeparatorComponents(createSeparator())
            .addTextDisplayComponents(createText(line));
    }

    return container;
}

function createStatusEmbed({ title, description, fields, color = getThemeGreen() }) {
    const embed = new EmbedBuilder().setColor(color);

    if (title) {
        embed.setTitle(title);
    }

    if (description) {
        embed.setDescription(description);
    }

    if (fields?.length) {
        embed.addFields(fields);
    }

    return embed;
}

function createPagerRow({ previousId, nextId, refreshId, page, pageCount }) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(previousId)
            .setLabel("Prev")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(refreshId)
            .setLabel(`Refresh ${page + 1}/${Math.max(pageCount, 1)}`)
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(nextId)
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= pageCount - 1)
    );
}

function shorten(value, maxLength) {
    const text = String(value);
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

module.exports = {
    ButtonStyle,
    addPrivateOption,
    createComponentsV2Payload,
    createContainer,
    createPagerRow,
    createSeparator,
    createStatusEmbed,
    createText,
    getThemeGreen,
    shorten,
    withSafeMentions
};
