const crypto = require("node:crypto");

const sessions = new Map();

function createSession(type, data, ttlMs = 1000 * 60 * 60 * 2) {
    const id = crypto.randomBytes(8).toString("base64url");
    sessions.set(id, {
        type,
        data,
        expiresAt: Date.now() + ttlMs
    });
    return id;
}

function getSession(id, expectedType) {
    pruneExpiredSessions();
    const session = sessions.get(id);

    if (!session) {
        return null;
    }

    if (expectedType && session.type !== expectedType) {
        return null;
    }

    return session.data;
}

function setSessionData(id, nextData) {
    const existing = sessions.get(id);
    if (!existing) {
        return false;
    }

    sessions.set(id, {
        ...existing,
        data: nextData
    });

    return true;
}

function deleteSession(id) {
    sessions.delete(id);
}

function pruneExpiredSessions() {
    const now = Date.now();
    for (const [key, value] of sessions.entries()) {
        if (value.expiresAt <= now) {
            sessions.delete(key);
        }
    }
}

setInterval(pruneExpiredSessions, 1000 * 60 * 10).unref();

module.exports = {
    createSession,
    deleteSession,
    getSession,
    setSessionData
};

