const { EJSON } = require("./mongo");

const TRIMMED_FIELD_TOKEN = "<trimmed for length>";

function countTopLevelFields(document) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
        return 1;
    }

    return Object.keys(document).length;
}

function pickResultPageSize(document) {
    const fieldCount = countTopLevelFields(document);

    if (fieldCount >= 5) {
        return 5;
    }

    return 10;
}

function makeDocumentPreview(document, maxLength) {
    const serialized = formatPreviewValue(EJSON.serialize(document, { relaxed: true }), 0);
    if (serialized.length <= maxLength) {
        return serialized;
    }

    return `${serialized.slice(0, Math.max(0, maxLength - 23))}\n... trimmed for display`;
}

function prepareEditableDocument(document, maxLength = 3600) {
    const clone = deepClone(document);
    const trimmedKeys = [];

    if (serialize(clone).length <= maxLength) {
        return {
            editableDocument: clone,
            trimmedKeys
        };
    }

    const candidates = Object.keys(clone)
        .filter(key => key !== "_id")
        .sort((left, right) => serialize(clone[right]).length - serialize(clone[left]).length);

    for (const key of candidates) {
        clone[key] = TRIMMED_FIELD_TOKEN;
        trimmedKeys.push(key);

        if (serialize(clone).length <= maxLength) {
            return {
                editableDocument: clone,
                trimmedKeys
            };
        }
    }

    throw new Error("This document is too large to safely edit in Discord. Export it, edit it locally, then re-import it.");
}

function restoreTrimmedFields(editedDocument, originalDocument, trimmedKeys) {
    const merged = deepClone(editedDocument);

    for (const key of trimmedKeys) {
        merged[key] = deepClone(originalDocument[key]);
    }

    merged._id = deepClone(originalDocument._id);
    return merged;
}

function summarizeDocumentChanges(before, after) {
    const beforeKeys = new Set(Object.keys(before || {}));
    const afterKeys = new Set(Object.keys(after || {}));
    const changed = [];
    const added = [];
    const removed = [];

    for (const key of afterKeys) {
        if (!beforeKeys.has(key)) {
            added.push(key);
            continue;
        }

        const beforeValue = serialize(before[key]);
        const afterValue = serialize(after[key]);
        if (beforeValue !== afterValue) {
            changed.push(key);
        }
    }

    for (const key of beforeKeys) {
        if (!afterKeys.has(key)) {
            removed.push(key);
        }
    }

    const lines = [];
    if (!changed.length && !added.length && !removed.length) {
        lines.push("- No effective changes detected.");
    }
    if (changed.length) {
        lines.push(`- Updated: ${changed.join(", ")}`);
    }
    if (added.length) {
        lines.push(`- Added: ${added.join(", ")}`);
    }
    if (removed.length) {
        lines.push(`- Removed: ${removed.join(", ")}`);
    }

    return lines.join("\n");
}

function deepClone(value) {
    return EJSON.deserialize(EJSON.serialize(value));
}

function serialize(value) {
    return EJSON.stringify(value, null, 0, { relaxed: false });
}

function formatPreviewValue(value, depth) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        if (!value.length) {
            return "[]";
        }

        const indent = "  ".repeat(depth);
        const childIndent = "  ".repeat(depth + 1);
        return `[\n${value.map(entry => `${childIndent}${formatPreviewValue(entry, depth + 1)}`).join(",\n")}\n${indent}]`;
    }

    const entries = Object.entries(value);
    if (!entries.length) {
        return "{}";
    }

    if (entries.length === 1 && entries[0][0].startsWith("$")) {
        const [key, childValue] = entries[0];
        return `{ ${JSON.stringify(key)}: ${formatInlinePreviewValue(childValue)} }`;
    }

    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `{\n${entries
        .map(([key, childValue]) => `${childIndent}${JSON.stringify(key)}: ${formatPreviewValue(childValue, depth + 1)}`)
        .join(",\n")}\n${indent}}`;
}

function formatInlinePreviewValue(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    return JSON.stringify(value);
}

module.exports = {
    TRIMMED_FIELD_TOKEN,
    makeDocumentPreview,
    pickResultPageSize,
    prepareEditableDocument,
    restoreTrimmedFields,
    summarizeDocumentChanges
};
