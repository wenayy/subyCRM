import { prisma } from "../lib/prisma";
import { inboxService } from "./inbox.service";

// Matrix event from mautrix bridge transaction
interface MatrixEvent {
  type: string;        // e.g. "m.room.message"
  sender: string;      // e.g. "@twitter_elonmusk:example.com"
  room_id: string;
  event_id: string;
  origin_server_ts: number;
  content?: {
    msgtype?: string;  // "m.text", "m.image", etc.
    body?: string;
  };
}

// Parse "@twitter_handle:domain" → { platform: "x", id: "handle" }
// Parse "@linkedin_urn~id:domain" → { platform: "linkedin", id: "urn~id" }
function parseBridgeSender(sender: string): { platform: "x" | "linkedin"; id: string } | null {
  const localpart = sender.split(":")[0].replace("@", "");
  if (localpart.startsWith("twitter_")) return { platform: "x", id: localpart.slice(8) };
  if (localpart.startsWith("linkedin_")) return { platform: "linkedin", id: localpart.slice(9) };
  return null;
}

async function resolveContact(
  platform: "x" | "linkedin",
  platformId: string,
  displayName: string,
  userId: string
): Promise<{ contactId: string; contactName: string }> {
  // Try to find existing contact by platform record
  const existing = await prisma.platform.findFirst({
    where: { type: platform, platformId },
    select: { contactId: true, contact: { select: { name: true } } },
  });

  if (existing) {
    return { contactId: existing.contactId, contactName: existing.contact.name };
  }

  // Auto-create contact from incoming message
  const name = displayName || platformId;
  const contact = await prisma.contact.create({
    data: {
      name,
      userId,
      platforms: {
        create: {
          type: platform,
          platformId,
          displayName: name,
        },
      },
    },
  });

  return { contactId: contact.id, contactName: contact.name };
}

export async function handleMatrixTransaction(
  txnId: string,
  events: MatrixEvent[],
  userId: string
): Promise<void> {
  for (const event of events) {
    // Only handle text messages
    if (event.type !== "m.room.message") continue;
    if (!event.content?.body) continue;

    const parsed = parseBridgeSender(event.sender);
    if (!parsed) continue; // message from our own bridge bot or homeserver — skip

    const { platform, id } = parsed;
    const body = event.content.body;
    const receivedAt = new Date(event.origin_server_ts);

    // Look up or auto-create contact
    const { contactId, contactName } = await resolveContact(platform, id, id, userId);

    await inboxService.upsert({
      platform,
      externalId: event.event_id,
      userId,
      contactId,
      contactName,
      senderId: id,
      preview: body.slice(0, 120),
      body,
      receivedAt,
      needsReply: true,
      fromMe: false,
    });
  }
}
