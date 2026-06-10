import { prisma } from "../server/lib/prisma";
import fetch from "node-fetch";

async function main() {
  const userId = "VtLh7xXUxheafzmAkdEP9ZytIvSAjO07";
  const bdapiToken = "bdapi_Glev9Sjnkls5x_21W1fm7rKdf9Dh44PQQjcnHx5Xgsg";

  // Find a test room ID for LinkedIn
  const sampleMsg = await (prisma as any).inboxMessage.findFirst({
    where: { userId, platform: "linkedin", matrixRoomId: { not: null } },
    select: { matrixRoomId: true }
  });

  if (!sampleMsg) {
    console.error("No sample LinkedIn room found in database!");
    return;
  }

  const roomId = sampleMsg.matrixRoomId;
  console.log(`Using sample room ID: ${roomId}`);

  // Try Beeper custom API endpoint: POST /v1/chats/{chatID}/messages
  const customUrl = `http://localhost:23373/v1/chats/${encodeURIComponent(roomId)}/messages`;
  console.log(`\nTrying custom Beeper API route: ${customUrl}`);
  try {
    const resCustom = await fetch(customUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bdapiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "Test message via bdapi_ token on custom local Beeper API",
      }),
    });

    console.log(`Status: ${resCustom.status} ${resCustom.statusText}`);
    const textCustom = await resCustom.text();
    console.log(`Response: ${textCustom}`);
  } catch (err: any) {
    console.error(`Error:`, err.message);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
