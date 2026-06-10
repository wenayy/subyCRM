import Database from "better-sqlite3";
import path from "path";
import os from "os";

const BEEPER_DB = path.join(os.homedir(), "Library", "Application Support", "BeeperTexts", "index.db");

async function main() {
  console.log(`Opening Beeper index.db at: ${BEEPER_DB}`);
  try {
    const db = new Database(BEEPER_DB, { readonly: true });

    console.log(`\nSchema of mx_room_messages:`);
    const info = db.prepare(`PRAGMA table_info(mx_room_messages)`).all();
    console.log(JSON.stringify(info, null, 2));

    // Get count of messages
    const count = db.prepare(`SELECT COUNT(*) as count FROM mx_room_messages`).get() as { count: number };
    console.log(`Total messages in mx_room_messages: ${count.count}`);

    // Print a sample message
    const sample = db.prepare(`SELECT * FROM mx_room_messages LIMIT 1`).get();
    console.log(`Sample message:`, JSON.stringify(sample, null, 2));

    db.close();
  } catch (err: any) {
    console.error("Error reading Beeper DB:", err.message);
  }
}

main();
