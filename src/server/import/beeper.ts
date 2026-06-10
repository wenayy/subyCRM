import Database from "better-sqlite3";
import path from "path";
import os from "os";
import { prisma } from "../lib/prisma";
import { inboxService } from "../services/inbox.service";


const BEEPER_DB = path.join(os.homedir(), "Library", "Application Support", "BeeperTexts", "index.db");

const BRIDGE_TO_PLATFORM: Record<string, "whatsapp" | "telegram" | "x" | "linkedin"> = {
  whatsapp: "whatsapp",
  telegram: "telegram",
  twitter: "x",
  linkedin: "linkedin",
};

export interface BeeperContact {
  name: string;
  platform: "whatsapp" | "telegram" | "x" | "linkedin";
  platformId: string;
  lastMessageTs: number | null;
  identifier_type?: string;
}

export function importFromBeeper(): { contacts: BeeperContact[]; errors: string[] } {
  const contacts: BeeperContact[] = [];
  const errors: string[] = [];

  try {
    const db = new Database(BEEPER_DB, { readonly: true });

    // Only import from 1:1 conversations (DMs), not group chats.
    // A DM room has exactly 2 participants (self + contact).
    const rows = db.prepare(`
      SELECT
        pi.account_id,
        p.id           AS participant_id,
        p.full_name,
        pi.identifier,
        pi.identifier_type,
        MAX(t.timestamp) AS last_ts
      FROM participant_identifiers pi
      JOIN participants p
        ON p.id = pi.participant_id AND p.account_id = pi.account_id
      JOIN threads t
        ON t.accountID = pi.account_id AND t.threadID = p.room_id
        AND t.timestamp > 0 AND t.is_label = 0
      WHERE p.is_self = 0
        AND (p.is_network_bot IS NULL OR p.is_network_bot = 0)
        AND (p.has_exited IS NULL OR p.has_exited = 0)
        AND p.full_name IS NOT NULL AND p.full_name != ''
        AND pi.account_id IN ('whatsapp', 'telegram', 'twitter', 'linkedin')
        -- only 1-on-1 rooms (self + this person)
        AND (
          SELECT COUNT(*) FROM participants px
          WHERE px.room_id = p.room_id AND px.account_id = p.account_id
        ) <= 2
      GROUP BY pi.account_id, p.id, pi.identifier_type
      ORDER BY last_ts DESC
    `).all() as Array<{
      account_id: string;
      participant_id: string;
      full_name: string;
      identifier: string;
      identifier_type: string;
      last_ts: number | null;
    }>;

    // Deduplicate: one entry per (bridge, participant).
    // For WhatsApp/Telegram: prefer phone identifier.
    // For Twitter/LinkedIn: use username/member-id.
    const seen = new Map<string, BeeperContact>();

    for (const row of rows) {
      const platform = BRIDGE_TO_PLATFORM[row.account_id];
      if (!platform) continue;

      let platformId = row.identifier.trim();
      if (!platformId) continue;

      // Normalise: strip leading @ for telegram/twitter (our DB convention)
      if (platform === "telegram" || platform === "x") {
        platformId = platformId.replace(/^@+/, "");
      }

      const key = `${row.account_id}:${row.participant_id}`;
      const existing = seen.get(key);
      const preferPhone = platform === "whatsapp" || platform === "telegram";

      if (!existing) {
        seen.set(key, {
          name: row.full_name.trim(),
          platform,
          platformId,
          lastMessageTs: row.last_ts ?? null,
          identifier_type: row.identifier_type,
        });
      } else if (preferPhone && row.identifier_type === "phone") {
        // Replace whatever we had with the actual phone number
        seen.set(key, { ...existing, platformId, identifier_type: row.identifier_type });
      } else if (!preferPhone && row.identifier_type === "username" && existing.identifier_type !== "username") {
        seen.set(key, { ...existing, platformId, identifier_type: row.identifier_type });
      }
    }

    contacts.push(...seen.values());
    db.close();

    const byPlatform: Record<string, number> = {};
    for (const c of contacts) byPlatform[c.platform] = (byPlatform[c.platform] ?? 0) + 1;
    console.log(`[beeper] Found ${contacts.length} DM contacts:`, byPlatform);
  } catch (err) {
    const msg = `Failed to read Beeper DB: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[beeper] ${msg}`);
  }

  return { contacts, errors };
}

export function getBeeperEchoId(eventId: string): string | null {
  try {
    const db = new Database(BEEPER_DB, { readonly: true });
    const row = db.prepare("SELECT echo_echoID FROM mx_room_messages WHERE eventID = ?").get(eventId) as { echo_echoID: string | null } | undefined;
    db.close();
    return row?.echo_echoID || null;
  } catch (err) {
    return null;
  }
}

export async function decryptEncryptedMessages(userId: string): Promise<number> {
  const encryptedMessages = await prisma.inboxMessage.findMany({
    where: {
      userId,
      body: "[Encrypted message]",
    },
    select: {
      id: true,
      externalId: true,
    },
  });

  if (encryptedMessages.length === 0) {
    return 0;
  }

  const externalIds = encryptedMessages.map((m: any) => m.externalId);
  console.log(`[beeper-local-decrypt] Found ${externalIds.length} encrypted placeholders to decrypt for user=${userId}`);

  let decryptedCount = 0;
  try {
    const db = new Database(BEEPER_DB, { readonly: true });
    const chunkSize = 500;
    for (let i = 0; i < externalIds.length; i += chunkSize) {
      const chunk = externalIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT eventID, message, text_content
        FROM mx_room_messages
        WHERE eventID IN (${placeholders})
      `).all(...chunk) as Array<{ eventID: string; message: string; text_content: string | null }>;

      for (const row of rows) {
        let plaintext: string | null = null;
        try {
          if (row.message) {
            const parsed = JSON.parse(row.message);
            plaintext = parsed.text || parsed.body || null;
          }
        } catch (e) {
          // ignore
        }
        if (!plaintext) {
          plaintext = row.text_content;
        }

        if (plaintext && plaintext !== "[Encrypted message]") {
          await prisma.inboxMessage.updateMany({
            where: { userId, externalId: row.eventID },
            data: {
              body: plaintext,
              preview: plaintext.slice(0, 120),
            },
          });
          decryptedCount++;
        }
      }
    }
    db.close();
    console.log(`[beeper-local-decrypt] Decrypted ${decryptedCount} messages successfully`);
  } catch (err: any) {
    console.error(`[beeper-local-decrypt] Error decrypting:`, err.message);
  }
  return decryptedCount;
}

export async function syncLocalMessagesForContacts(userId: string): Promise<{ synced: number }> {
  console.log(`[beeper-local-sync] Syncing local decrypted messages for user=${userId}`);
  let synced = 0;

  try {
    const platforms = await prisma.platform.findMany({
      where: { contact: { userId } },
      include: { contact: true },
    });

    if (platforms.length === 0) {
      console.log(`[beeper-local-sync] No platforms found for user=${userId}`);
      return { synced };
    }

    const db = new Database(BEEPER_DB, { readonly: true });

    const PLATFORM_TO_BRIDGE: Record<string, string> = {
      whatsapp: "whatsapp",
      telegram: "telegram",
      x: "twitter",
      linkedin: "linkedin",
    };

    for (const p of platforms) {
      const bridge = PLATFORM_TO_BRIDGE[p.type];
      if (!bridge) continue;

      const newestMessage = await prisma.inboxMessage.findFirst({
        where: {
          userId,
          contactId: p.contactId,
          platform: p.type,
        },
        orderBy: {
          receivedAt: "desc",
        },
        select: {
          receivedAt: true,
        },
      });

      // Subtract 24-hour buffer from the newest message's timestamp to prevent missing
      // messages due to out-of-order writes or clock variations.
      const lastTimestamp = newestMessage
        ? Math.max(0, newestMessage.receivedAt.getTime() - 24 * 60 * 60 * 1000)
        : 0;

      const query = `
        SELECT
          m.eventID AS externalId,
          m.echo_echoID AS echoEchoId,
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
          AND (pi.identifier = ? OR pi.identifier = ?)
          AND m.timestamp > ?
        ORDER BY m.timestamp ASC
      `;

      const rows = db.prepare(query).all(bridge, p.platformId, `@${p.platformId}`, lastTimestamp) as Array<{
        externalId: string;
        echoEchoId: string | null;
        matrixRoomId: string;
        timestamp: number;
        isSentByMe: number;
        message: string;
        text_content: string | null;
      }>;

      if (rows.length > 0) {
        console.log(`[beeper-local-sync] Found ${rows.length} new messages from SQLite for contact="${p.contact.name}" (${p.type}:${p.platformId})`);
      }

      for (const row of rows) {
        let body: string | null = null;
        try {
          if (row.message) {
            const parsed = JSON.parse(row.message);
            body = parsed.text || parsed.body || null;
          }
        } catch (e) {
          // ignore
        }
        if (!body) {
          body = row.text_content || "[No message content]";
        }

        const isFromMe = !!row.isSentByMe;
        const isOld = new Date(row.timestamp) < new Date(Date.now() - 24 * 60 * 60 * 1000);
        const read = isFromMe || isOld ? true : undefined;

        // Resolve pending/echo ID if it exists in the database
        if (isFromMe && row.echoEchoId) {
          const pendingMsg = await prisma.inboxMessage.findFirst({
            where: {
              userId,
              platform: p.type,
              externalId: row.echoEchoId,
            },
          });
          if (pendingMsg) {
            console.log(`[beeper-local-sync] Resolving pending message ID ${row.echoEchoId} -> ${row.externalId}`);
            await prisma.inboxMessage.update({
              where: { id: pendingMsg.id },
              data: { externalId: row.externalId },
            }).catch((err: any) => console.error("[beeper-local-sync] Failed to update pending message ID:", err.message));
          }
        }

        await (prisma as any).inboxMessage.upsert({
          where: {
            platform_externalId_userId: {
              platform: p.type,
              externalId: row.externalId,
              userId,
            },
          },
          create: {
            platform: p.type,
            externalId: row.externalId,
            userId,
            contactId: p.contactId,
            contactName: p.contact.name,
            senderId: isFromMe ? undefined : p.platformId,
            preview: body.slice(0, 120),
            body,
            receivedAt: new Date(row.timestamp),
            fromMe: isFromMe,
            matrixRoomId: row.matrixRoomId,
            ...(read !== undefined ? { read } : {}),
          },
          update: {
            contactId: p.contactId,
            contactName: p.contact.name,
            preview: body.slice(0, 120),
            body,
            receivedAt: new Date(row.timestamp),
            fromMe: isFromMe,
            matrixRoomId: row.matrixRoomId,
          },
        });

        synced++;
      }

      if (rows.length > 0) {
        const maxTimestamp = Math.max(...rows.map(r => r.timestamp));
        const contact = await prisma.contact.findUnique({
          where: { id: p.contactId },
          select: { lastContactDate: true },
        });
        if (contact && (!contact.lastContactDate || new Date(maxTimestamp) > contact.lastContactDate)) {
          await prisma.contact.update({
            where: { id: p.contactId },
            data: { lastContactDate: new Date(maxTimestamp) },
          }).catch((e: any) => console.error("[beeper-local-sync] Failed to update contact lastContactDate:", e.message));
        }
      }
    }

    db.close();
    console.log(`[beeper-local-sync] Sync completed. Total synced: ${synced} messages`);
  } catch (err: any) {
    console.error(`[beeper-local-sync] Local message sync failed:`, err.message);
  }

  return { synced };
}

