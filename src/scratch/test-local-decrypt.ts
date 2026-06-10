import { prisma } from "../server/lib/prisma";
import { decryptEncryptedMessages, syncLocalMessagesForContacts } from "../server/import/beeper";

async function main() {
  const userId = "VtLh7xXUxheafzmAkdEP9ZytIvSAjO07";
  console.log(`Running local decryption & sync test for user: ${userId}`);

  try {
    const localSyncedResult = await syncLocalMessagesForContacts(userId);
    console.log(`Local SQLite sync complete: synced ${localSyncedResult.synced} messages`);

    const decryptedCount = await decryptEncryptedMessages(userId);
    console.log(`Decrypted ${decryptedCount} messages successfully`);

    // Let's print some stats on linkedin/x messages for this user
    const totalMsgCount = await (prisma as any).inboxMessage.count({
      where: { userId, platform: { in: ["linkedin", "x"] } }
    });
    console.log(`Total LinkedIn/X messages in CRM DB: ${totalMsgCount}`);

    const encryptedCount = await (prisma as any).inboxMessage.count({
      where: { userId, platform: { in: ["linkedin", "x"] }, body: "[Encrypted message]" }
    });
    console.log(`Remaining E2EE placeholder messages: ${encryptedCount}`);

    // Print a few decrypted messages to confirm
    const sampleMsgs = await (prisma as any).inboxMessage.findMany({
      where: { userId, platform: { in: ["linkedin", "x"] } },
      orderBy: { receivedAt: "desc" },
      take: 5,
    });
    console.log("Sample messages from DB:", JSON.stringify(sampleMsgs.map((m: any) => ({
      platform: m.platform,
      contactName: m.contactName,
      body: m.body,
      fromMe: m.fromMe,
      receivedAt: m.receivedAt
    })), null, 2));

  } catch (err: any) {
    console.error("Local test error:", err.message || err);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
