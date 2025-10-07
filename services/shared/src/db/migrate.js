"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const client_1 = require("./client");
async function migrate() {
    const client = await (0, client_1.createPostgresClient)();
    try {
        console.log('Running database migrations...');
        const schemaPath = path_1.default.join(__dirname, 'schema.sql');
        const schema = await promises_1.default.readFile(schemaPath, 'utf-8');
        await client.query(schema);
        console.log('Database migrations completed successfully');
    }
    catch (error) {
        console.error('Migration failed:', error);
        throw error;
    }
    finally {
        await client.end();
    }
}
if (require.main === module) {
    migrate().catch((error) => {
        console.error('Fatal error during migration:', error);
        process.exit(1);
    });
}
exports.default = migrate;
//# sourceMappingURL=migrate.js.map