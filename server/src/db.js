import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "../data/app.db");

export const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

export async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      teacher_token TEXT NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT,
      duration_minutes INTEGER NOT NULL,
      started_at TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      options_json TEXT,
      answer_json TEXT NOT NULL,
      marks REAL NOT NULL DEFAULT 1,
      topic TEXT,
      FOREIGN KEY (test_id) REFERENCES tests(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL,
      roll_number TEXT NOT NULL,
      name TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      UNIQUE(test_id, roll_number),
      FOREIGN KEY (test_id) REFERENCES tests(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL,
      current_index INTEGER NOT NULL DEFAULT 0,
      answers_json TEXT NOT NULL DEFAULT '{}',
      answer_timestamps_json TEXT NOT NULL DEFAULT '{}',
      paper_json TEXT,
      option_orders_json TEXT,
      tab_switch_count INTEGER NOT NULL DEFAULT 0,
      fullscreen_exit_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      submitted_at TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      score REAL,
      FOREIGN KEY (test_id) REFERENCES tests(id),
      FOREIGN KEY (participant_id) REFERENCES participants(id),
      UNIQUE(test_id, participant_id)
    )
  `);

  const testColumns = await all("PRAGMA table_info(tests)");
  if (!testColumns.some((c) => c.name === "teacher_token")) {
    await run("ALTER TABLE tests ADD COLUMN teacher_token TEXT DEFAULT ''");
  }

  const attemptColumns = await all("PRAGMA table_info(attempts)");
  if (!attemptColumns.some((c) => c.name === "paper_json")) {
    await run("ALTER TABLE attempts ADD COLUMN paper_json TEXT");
  }
  if (!attemptColumns.some((c) => c.name === "option_orders_json")) {
    await run("ALTER TABLE attempts ADD COLUMN option_orders_json TEXT");
  }
  if (!attemptColumns.some((c) => c.name === "answer_timestamps_json")) {
    await run("ALTER TABLE attempts ADD COLUMN answer_timestamps_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!attemptColumns.some((c) => c.name === "tab_switch_count")) {
    await run("ALTER TABLE attempts ADD COLUMN tab_switch_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!attemptColumns.some((c) => c.name === "fullscreen_exit_count")) {
    await run("ALTER TABLE attempts ADD COLUMN fullscreen_exit_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!attemptColumns.some((c) => c.name === "warning_count")) {
    await run("ALTER TABLE attempts ADD COLUMN warning_count INTEGER NOT NULL DEFAULT 0");
  }
}

export { run, get, all };
