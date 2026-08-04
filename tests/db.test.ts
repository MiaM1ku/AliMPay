import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, getSetting, type AppDatabase } from "../src/server/db";

let directory = "";
const opened: AppDatabase[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

function seedLegacyLayer(path: string, layer: number) {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  `);
  database.query("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  database.query("INSERT INTO settings(key, value_json, is_secret, updated_at) VALUES ('transfer_link_layer', ?, 0, ?)")
    .run(JSON.stringify(layer), new Date().toISOString());
  database.close();
}

describe("database settings migrations", () => {
  it("maps the old five-layer numbering to the retained three layers once", () => {
    directory = mkdtempSync(join(tmpdir(), "alimpay-db-test-"));
    const cases: Array<readonly [number, number]> = [[5, 1], [4, 2], [3, 3], [2, 3], [1, 3]];
    for (const [legacy, expected] of cases) {
      const path = join(directory, `legacy-${legacy}.sqlite`);
      seedLegacyLayer(path, legacy);
      const database = createDatabase(path);
      expect(getSetting(database, "transfer_link_layer", 0)).toBe(expected);
      expect(database.query("SELECT 1 FROM schema_migrations WHERE version = 2").get()).not.toBeNull();
      database.close();

      const reopened = createDatabase(path);
      opened.push(reopened);
      expect(getSetting(reopened, "transfer_link_layer", 0)).toBe(expected);
    }
  });

  it("uses the verified HTTPS layer for new databases", () => {
    directory = mkdtempSync(join(tmpdir(), "alimpay-db-test-"));
    const database = createDatabase(join(directory, "fresh.sqlite"));
    opened.push(database);
    expect(getSetting(database, "transfer_link_layer", 0)).toBe(2);
  });
});
