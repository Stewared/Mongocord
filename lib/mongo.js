const { MongoClient } = require("mongodb");
const { EJSON } = require("bson");
const { env } = require("../setEnvs");

let mongoClientPromise;

async function getMongoClient() {
    if (!mongoClientPromise) {
        const client = new MongoClient(env.mongoUri, {
            ignoreUndefined: true
        });

        mongoClientPromise = client.connect();
    }

    return mongoClientPromise;
}

async function getAdmin() {
    const client = await getMongoClient();
    return client.db().admin();
}

async function getDatabase(name) {
    const client = await getMongoClient();
    return client.db(name);
}

async function getStateDatabase() {
    const client = await getMongoClient();
    return client.db(env.stateDatabaseName || "discordMongoClient");
}

function toExtendedJson(value, relaxed = false) {
    return EJSON.stringify(value, null, 2, { relaxed });
}

module.exports = {
    EJSON,
    getAdmin,
    getDatabase,
    getMongoClient,
    getStateDatabase,
    toExtendedJson
};
