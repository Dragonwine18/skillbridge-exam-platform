const Database = require("better-sqlite3");

const db = new Database("exam-platform.db");

// -------------------------
// Admins
// -------------------------

db.prepare(`
    CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'examiner'
    )
`).run();

// -------------------------
// Exams
// -------------------------

db.prepare(`
    CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        duration INTEGER NOT NULL,
        questions TEXT NOT NULL,
        admin_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
    )
`).run();

// -------------------------
// Question Banks
// -------------------------

db.prepare(`
    CREATE TABLE IF NOT EXISTS question_banks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        questions TEXT NOT NULL,
        admin_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
    )
`).run();

console.log("Database ready.");

module.exports = db;