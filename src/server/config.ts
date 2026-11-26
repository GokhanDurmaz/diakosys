import fs from "node:fs";
import path from "node:path";
import { openDatabase, closeDatabase, applyMigrations } from "../db.ts";
import { TaskStore } from "../store.ts";
import { DiscoveryRunStore } from "../discovery.ts";

export interface ApiServerConfig {
  host: string;
  port: number;
  dbPath?: string;
}

export function defaultDbPath(): string {
  if (process.env.DIAKOSYS_ORCHESTRATOR_DB !== undefined && process.env.DIAKOSYS_ORCHESTRATOR_DB !== "") {
    return String(process.env.DIAKOSYS_ORCHESTRATOR_DB);
  }
  const dataHome =
    process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? ".", ".local", "share");
  return path.join(dataHome, "diakosys-orchestrator", "tasks.db");
}

export function createApiConfig(host: string, port: number, dbPath?: string): ApiServerConfig {
  return {
    host,
    port,
    dbPath: dbPath ?? defaultDbPath(),
  };
}

export async function initializeApiDatabase(dbPath: string): Promise<{ store: TaskStore; runs: DiscoveryRunStore }> {
  console.log(`[API] Initializing database at: ${dbPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  console.log("[API] Database opened, applying migrations...");
  applyMigrations(db);
  console.log("[API] Migrations applied successfully");
  const store = new TaskStore(db);
  const runs = new DiscoveryRunStore(db);
  return { store, runs };
}

export function closeApiDatabase(db: ReturnType<typeof openDatabase>): void {
  closeDatabase(db);
}
