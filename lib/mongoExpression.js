const vm = require("node:vm");
const { EJSON } = require("bson");
const {
    Binary,
    BSONRegExp,
    Code,
    DBRef,
    Decimal128,
    Double,
    Int32,
    Long,
    MaxKey,
    MinKey,
    ObjectId,
    Timestamp,
    UUID
} = require("mongodb");

const DISALLOWED_PATTERNS = [
    /\b(?:process|global|globalThis|module|require|Function|eval|import|constructor|prototype|__proto__)\b/,
    /\b(?:while|for|do|class|try|catch|throw|switch|with|function|async|await)\b/,
    /=>/,
    /;/
];

function createSandbox() {
    const sandbox = Object.create(null);

    Object.assign(sandbox, {
        ObjectId: (value) => new ObjectId(value),
        UUID: (value) => new UUID(value),
        ISODate: (value) => new Date(value),
        Date,
        RegExp,
        NumberInt: (value) => new Int32(Number(value)),
        NumberLong: (value) => Long.fromString(String(value)),
        NumberDouble: (value) => new Double(Number(value)),
        NumberDecimal: (value) => Decimal128.fromString(String(value)),
        Timestamp: (high, low) => Timestamp.fromBits(low ?? 0, high ?? 0),
        BinData: (_subtype, value) => new Binary(Buffer.from(String(value), "base64")),
        MinKey: () => new MinKey(),
        MaxKey: () => new MaxKey(),
        BSONRegExp: (pattern, options) => new BSONRegExp(pattern, options),
        Code: (code, scope) => new Code(code, scope),
        DBRef: (collection, id, database) => new DBRef(collection, id, database),
        Math,
        JSON
    });

    return vm.createContext(sandbox, {
        codeGeneration: {
            strings: false,
            wasm: false
        }
    });
}

function parseMongoExpression(source, options = {}) {
    const {
        defaultValue = {},
        expect = "object",
        label = "input"
    } = options;

    const trimmed = String(source ?? "").trim();
    if (!trimmed) {
        return defaultValue;
    }

    for (const pattern of DISALLOWED_PATTERNS) {
        if (pattern.test(trimmed)) {
            throw new Error(`${label} contains unsupported or unsafe syntax.`);
        }
    }

    try {
        const parsedViaEjson = EJSON.parse(trimmed, { relaxed: false });
        validateParsedType(parsedViaEjson, expect, label);
        return parsedViaEjson;
    }
    catch {
        const wrapped = `"use strict"; (${trimmed})`;
        const result = vm.runInContext(wrapped, createSandbox(), {
            timeout: 150
        });
        validateParsedType(result, expect, label);
        return result;
    }
}

function validateParsedType(value, expect, label) {
    if (expect === "array" && !Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }

    if (expect === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`${label} must be an object.`);
    }
}

module.exports = {
    parseMongoExpression
};
