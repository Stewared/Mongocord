function makeCustomId(...parts) {
    return parts.join("|").slice(0, 100);
}

function parseCustomId(customId) {
    return String(customId).split("|");
}

module.exports = {
    makeCustomId,
    parseCustomId
};

