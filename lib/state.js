const { getStateDatabase } = require("./mongo");

async function getCollection(name) {
    const db = await getStateDatabase();
    return db.collection(name);
}

const GLOBAL_PIPELINE_SCOPE = "global";

async function ensureStateIndexes() {
    const preferences = await getCollection("userPreferences");
    const recentQueries = await getCollection("recentQueries");
    const savedPipelines = await getCollection("savedPipelines");

    await Promise.all([
        preferences.createIndex({ userId: 1 }, { unique: true }),
        recentQueries.createIndex({ userId: 1, nameKey: 1 }, { unique: true }),
        recentQueries.createIndex({ userId: 1, updatedAt: -1 }),
        savedPipelines.createIndex({ userId: 1, nameKey: 1 }, { unique: true }),
        savedPipelines.createIndex({ userId: 1, updatedAt: -1 }),
        savedPipelines.createIndex(
            { scope: 1, nameKey: 1 },
            {
                unique: true,
                partialFilterExpression: { scope: GLOBAL_PIPELINE_SCOPE }
            }
        ),
        savedPipelines.createIndex(
            { scope: 1, updatedAt: -1 },
            { partialFilterExpression: { scope: GLOBAL_PIPELINE_SCOPE } }
        )
    ]);
}

function normalizeName(name) {
    return String(name).trim().toLowerCase();
}

async function getGlobalConfig() {
    const settings = await getCollection("settings");
    const existing = await settings.findOne({ _id: "global" });

    if (existing) {
        return existing;
    }

    const created = {
        _id: "global",
        databaseAdmins: [],
        createdAt: new Date(),
        updatedAt: new Date()
    };

    await settings.insertOne(created);
    return created;
}

async function setDatabaseAdmin(userId) {
    const settings = await getCollection("settings");
    await settings.updateOne(
        { _id: "global" },
        {
            $setOnInsert: { createdAt: new Date() },
            $set: { updatedAt: new Date() },
            $addToSet: { databaseAdmins: userId }
        },
        { upsert: true }
    );
}

async function removeDatabaseAdmin(userId) {
    const settings = await getCollection("settings");
    await settings.updateOne(
        { _id: "global" },
        {
            $set: { updatedAt: new Date() },
            $pull: { databaseAdmins: userId }
        }
    );
}

async function getUserPreferences(userId) {
    const preferences = await getCollection("userPreferences");
    const existing = await preferences.findOne({ userId });

    return existing || {
        userId,
        confirmationsEnabled: true
    };
}

async function setConfirmationsEnabled(userId, enabled) {
    const preferences = await getCollection("userPreferences");
    await preferences.updateOne(
        { userId },
        {
            $set: {
                userId,
                confirmationsEnabled: Boolean(enabled),
                updatedAt: new Date()
            },
            $setOnInsert: {
                createdAt: new Date()
            }
        },
        { upsert: true }
    );
}

async function trimRecentQueries(userId) {
    const recentQueries = await getCollection("recentQueries");
    const overflow = await recentQueries
        .find({ userId })
        .sort({ updatedAt: -1 })
        .skip(10)
        .project({ _id: 1 })
        .toArray();

    if (overflow.length) {
        await recentQueries.deleteMany({
            _id: {
                $in: overflow.map(entry => entry._id)
            }
        });
    }
}

async function upsertRecentQuery(userId, currentName, payload) {
    const recentQueries = await getCollection("recentQueries");
    const now = new Date();
    const nextName = String(payload.name || currentName || "").trim();

    if (!nextName) {
        if (currentName) {
            await recentQueries.deleteOne({
                userId,
                nameKey: normalizeName(currentName)
            });
        }
        return null;
    }

    if (currentName && normalizeName(currentName) !== normalizeName(nextName)) {
        await recentQueries.deleteOne({
            userId,
            nameKey: normalizeName(currentName)
        });
    }

    await recentQueries.updateOne(
        {
            userId,
            nameKey: normalizeName(nextName)
        },
        {
            $set: {
                userId,
                name: nextName,
                nameKey: normalizeName(nextName),
                database: payload.database,
                collection: payload.collection,
                filterSource: payload.filterSource,
                projectionSource: payload.projectionSource,
                sortSource: payload.sortSource,
                optionsSource: payload.optionsSource,
                updatedAt: now
            },
            $setOnInsert: {
                createdAt: now
            }
        },
        { upsert: true }
    );

    await trimRecentQueries(userId);
    return nextName;
}

async function listRecentQueries(userId, prefix = "") {
    const recentQueries = await getCollection("recentQueries");
    const matcher = prefix
        ? {
            nameKey: {
                $regex: `^${escapeRegex(prefix.toLowerCase())}`
            }
        }
        : {};

    return recentQueries
        .find({
            userId,
            ...matcher
        })
        .sort({ updatedAt: -1 })
        .limit(10)
        .toArray();
}

async function getRecentQuery(userId, name) {
    const recentQueries = await getCollection("recentQueries");
    return recentQueries.findOne({
        userId,
        nameKey: normalizeName(name)
    });
}

async function upsertSavedPipeline(currentName, payload, updatedBy = null) {
    const savedPipelines = await getCollection("savedPipelines");
    const now = new Date();
    const nextName = String(payload.name || currentName || "").trim();

    if (!nextName) {
        throw new Error("Saved pipelines need a name.");
    }

    const currentNameKey = currentName ? normalizeName(currentName) : null;
    const nextNameKey = normalizeName(nextName);

    if (currentNameKey && currentNameKey !== nextNameKey) {
        await savedPipelines.deleteOne({
            scope: GLOBAL_PIPELINE_SCOPE,
            nameKey: currentNameKey
        });
    }

    await savedPipelines.updateOne(
        {
            scope: GLOBAL_PIPELINE_SCOPE,
            nameKey: nextNameKey
        },
        {
            $set: {
                scope: GLOBAL_PIPELINE_SCOPE,
                name: nextName,
                nameKey: nextNameKey,
                database: payload.database,
                collection: payload.collection,
                pipelineSource: payload.pipelineSource,
                stages: payload.stages || null,
                updatedAt: now,
                ...(updatedBy ? { updatedBy } : {})
            },
            $setOnInsert: {
                createdAt: now,
                ...(updatedBy ? { createdBy: updatedBy } : {})
            }
        },
        { upsert: true }
    );

    return nextName;
}

async function listSavedPipelines(prefix = "") {
    const savedPipelines = await getCollection("savedPipelines");
    const matcher = prefix
        ? {
            nameKey: {
                $regex: `^${escapeRegex(prefix.toLowerCase())}`
            }
        }
        : {};

    const globalResults = await savedPipelines
        .find({
            scope: GLOBAL_PIPELINE_SCOPE,
            ...matcher
        })
        .sort({ updatedAt: -1 })
        .limit(25)
        .toArray();

    // Backward compatibility for pre-global records.
    const legacy = await savedPipelines
        .find({
            scope: { $exists: false },
            ...matcher
        })
        .sort({ updatedAt: -1 })
        .limit(200)
        .toArray();

    const seen = new Set();
    const merged = [];
    for (const entry of [...globalResults, ...legacy]) {
        if (seen.has(entry.nameKey)) {
            continue;
        }

        seen.add(entry.nameKey);
        merged.push(entry);
        if (merged.length >= 25) {
            break;
        }
    }

    return merged;
}

async function getSavedPipeline(name) {
    const savedPipelines = await getCollection("savedPipelines");
    const nameKey = normalizeName(name);

    const global = await savedPipelines.findOne({
        scope: GLOBAL_PIPELINE_SCOPE,
        nameKey
    });

    if (global) {
        return global;
    }

    return savedPipelines.findOne(
        { nameKey },
        { sort: { updatedAt: -1 } }
    );
}

async function deleteSavedPipeline(name) {
    const savedPipelines = await getCollection("savedPipelines");
    const nameKey = normalizeName(name);
    return savedPipelines.deleteMany({
        $or: [
            {
                scope: GLOBAL_PIPELINE_SCOPE,
                nameKey
            },
            {
                scope: { $exists: false },
                nameKey
            }
        ]
    });
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
    deleteSavedPipeline,
    ensureStateIndexes,
    getGlobalConfig,
    getRecentQuery,
    getSavedPipeline,
    getUserPreferences,
    listRecentQueries,
    listSavedPipelines,
    removeDatabaseAdmin,
    setConfirmationsEnabled,
    setDatabaseAdmin,
    upsertRecentQuery,
    upsertSavedPipeline
};
