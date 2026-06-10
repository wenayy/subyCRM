import Database from "better-sqlite3";
import path from "path";
import os from "os";

const BEEPER_DB = path.join(os.homedir(), "Library", "Application Support", "BeeperTexts", "index.db");

const PLATFORM_TO_BRIDGE: Record<string, string> = {
  whatsapp: "whatsapp",
  telegram: "telegram",
  x: "twitter",
  linkedin: "linkedin",
};

async function main() {
  const db = new Database(BEEPER_DB, { readonly: true });

  // Let's assume we want to sync for:
  // - linkedin: Dhwani Aggarwal (identifier: ACoAADzXrGQBii6vqkVq2nKhuxkOSCz7WHm0Kvs)
  // - twitter: some identifier
  const testContacts = [
    { platform: "linkedin", platformId: "ACoAADzXrGQBii6vqkVq2nKhuxkOSCz7WHm0Kvs" },
  ];

  const startTime = Date.now();

  for (const c of testContacts) {
    const bridge = PLATFORM_TO_BRIDGE[c.platform];
    const lastTimestamp = 0; // Sync from beginning for test

    const query = `
      SELECT
        m.eventID AS externalId,
        m.roomID AS matrixRoomId,
        m.timestamp,
        m.isSentByMe,
        m.message,
        m.text_content
      FROM mx_room_messages m
      JOIN participants p ON p.room_id = m.roomID AND p.is_self = 0
      JOIN participant_identifiers pi ON p.id = pi.participant_id AND p.account_id = pi.account_id
      WHERE m.type != 'HIDDEN'
        AND pi.account_id = ?
        AND pi.identifier = ?
        AND m.timestamp > ?
      ORDER BY m.timestamp ASC
    `;

    const rows = db.prepare(query).all(bridge, c.platformId, lastTimestamp) as any[];
    console.log(`Contact: ${c.platformId} (${c.platform})`);
    console.log(`Found ${rows.length} messages in ${Date.now() - startTime}ms`);
    if (rows.length > 0) {
      console.log("First message:", rows[0]);
    }
  }

  db.close();
}

main().catch(console.error);
