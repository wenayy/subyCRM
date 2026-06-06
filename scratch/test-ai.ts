import { prisma } from "../src/server/lib/prisma";
import { aiService } from "../src/server/services/ai.service";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function test() {
  const contactId = "opt-whatsapp-yogesh-vishwakarma"; // Let's search for a contact named Yogesh first
  const contact = await prisma.contact.findFirst({
    where: { name: { contains: "Yogesh", mode: "insensitive" } },
    include: {
      platforms: true,
      interactions: { orderBy: { occurredAt: "desc" }, take: 20 },
      notes: { orderBy: { createdAt: "desc" }, take: 10 },
      contactTags: { include: { tag: true } },
    },
  });

  if (!contact) {
    console.error("Yogesh contact not found in database.");
    const all = await prisma.contact.findMany({ take: 5 });
    console.log("Existing contacts:", all.map(c => c.name));
    return;
  }

  console.log("Contact found:", contact.name, contact.id);
  console.log("Platform count:", contact.platforms.length);
  console.log("Interaction count:", contact.interactions.length);
  console.log("Notes count:", contact.notes.length);

  try {
    console.log("\n--- Testing generateSummary ---");
    const summary = await aiService.generateSummary(contact);
    console.log("Result:", summary);

    console.log("\n--- Testing generatePrep ---");
    const prep = await aiService.generatePrep(contact);
    console.log("Result:", JSON.stringify(prep, null, 2));
  } catch (err: any) {
    console.error("Error during AI service test:", err);
  }
}

test();
