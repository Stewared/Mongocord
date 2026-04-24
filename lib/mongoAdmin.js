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

module.exports = {
    listCollectionNames,
    listDatabaseNames
};
