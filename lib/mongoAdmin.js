const { getAdmin, getDatabase } = require("./mongo");

async function listDatabaseNames() {
    const admin = await getAdmin();
    const result = await admin.listDatabases();
    return result.databases
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

async function listCollectionNames(databaseName) {
    const db = await getDatabase(databaseName);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    return collections
        .map(entry => entry.name)
        .filter(name => !name.startsWith("system."))
        .sort((left, right) => left.localeCompare(right));
}

async function listDatabasesWithCollectionCounts() {
    const names = await listDatabaseNames();
    const entries = await Promise.all(names.map(async name => {
        const db = await getDatabase(name);
        const collections = await db.listCollections({}, { nameOnly: true }).toArray();
        const collectionCount = collections.filter(entry => !entry.name.startsWith("system.")).length;
        return {
            name,
            collectionCount
        };
    }));

    return entries;
}

async function listCollectionsWithDocumentCounts(databaseName) {
    const db = await getDatabase(databaseName);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const names = collections
        .map(entry => entry.name)
        .filter(name => !name.startsWith("system."))
        .sort((left, right) => left.localeCompare(right));

    const entries = await Promise.all(names.map(async name => {
        const estimatedDocumentCount = await db.collection(name).estimatedDocumentCount();
        return {
            name,
            documentCount: estimatedDocumentCount
        };
    }));

    return entries;
}

module.exports = {
    listCollectionsWithDocumentCounts,
    listCollectionNames,
    listDatabasesWithCollectionCounts,
    listDatabaseNames
};
