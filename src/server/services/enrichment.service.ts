import { prisma } from "../lib/prisma";
import OpenAI from "openai";
import { aiService, sanitizeType, sanitizeDomain } from "./ai.service";
import { cache } from "../lib/cache";

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

interface EnrichResult {
  linkedin_url?: string;
  linkedin_slug?: string;
  twitter_handle?: string;
  twitter_url?: string;
  full_name?: string;
  role?: string;
  company?: string;
  bio?: string;
  followers?: string;
  company_website?: string;
  company_description?: string;
  company_linkedin?: string;
  company_sector?: string;
  company_size?: string;
  company_funding?: string;
}

async function webSearchEnrich(
  context: { name: string; company?: string | null; role?: string | null },
): Promise<EnrichResult> {
  const contextStr = [
    `Name: ${context.name}`,
    context.company ? `Company: ${context.company}` : null,
    context.role ? `Role: ${context.role}` : null,
  ].filter(Boolean).join(", ");

  const prompt = `You are a professional researcher enriching a CRM contact record.

Find accurate information for this person: ${contextStr}

Search for:
1. Their LinkedIn profile (linkedin.com/in/...)
2. Their Twitter/X profile (x.com/... or twitter.com/...)
3. If you find a company, also find the company's website and brief description

IMPORTANT accuracy rules:
- Only return a LinkedIn/Twitter profile if you are CERTAIN it belongs to this specific person
- The name on the profile must match or be a close variation of "${context.name}"
- If you find multiple people with this name, pick the one that matches the company/role context
- If you cannot confidently identify the right person, leave those fields null
- Extract the actual slug/handle from the real URL — do not guess or hallucinate URLs

Return ONLY valid JSON (no markdown):
{
  "full_name": "<full name as it appears on their profile, or null>",
  "role": "<current job title, or null>",
  "company": "<current company name, or null>",
  "bio": "<1-2 sentence summary of who they are based on what you found>",
  "linkedin_url": "<full linkedin.com/in/slug URL, or null>",
  "linkedin_slug": "<just the slug part after /in/, or null>",
  "twitter_handle": "<handle without @, or null>",
  "twitter_url": "<full x.com/handle URL, or null>",
  "followers": "<e.g. 12.4K followers, or null>",
  "company_website": "<official company homepage URL, or null>",
  "company_description": "<1-2 sentences about what the company does, or null>",
  "company_linkedin": "<company linkedin URL, or null>",
  "company_sector": "<one of: payment, blockchain, saas, ecommerce, ai, marketing, legal, finance, other — or null>",
  "company_size": "<one of: startup, scaleup, enterprise — or null>",
  "company_funding": "<e.g. seed, series-a, public — or null>"
}`;

  try {
    const resp = await (getOpenAI() as any).responses.create({
      model: "gpt-4o",
      tools: [{ type: "web_search_preview" }],
      input: prompt,
    });

    // Extract text output from response
    const text = resp.output
      ?.filter((o: any) => o.type === "message")
      ?.flatMap((o: any) => o.content)
      ?.filter((c: any) => c.type === "output_text")
      ?.map((c: any) => c.text)
      ?.join("") ?? "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]) as EnrichResult;
  } catch (err) {
    console.error("[enrichment] Web search enrich failed:", err);
    // Fall back to SerpAPI if web search fails
    return serpFallbackEnrich(context);
  }
}

// ── SerpAPI fallback (used if OpenAI web search unavailable) ──────────────────
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

async function serpFallbackEnrich(
  context: { name: string; company?: string | null; role?: string | null },
): Promise<EnrichResult> {
  if (!SERPAPI_KEY) return {};
  const result: EnrichResult = {};

  try {
    const q = context.company
      ? `site:linkedin.com/in "${context.name}" "${context.company}"`
      : `site:linkedin.com/in "${context.name}"`;
    const res = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(q)}&api_key=${SERPAPI_KEY}&num=3`);
    if (res.ok) {
      const data = await res.json() as { organic_results?: Array<{ link?: string; title?: string; snippet?: string }> };
      const top = data.organic_results?.[0];
      if (top?.link) {
        const slug = top.link.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
        if (slug) {
          result.linkedin_slug = slug;
          result.linkedin_url = `https://www.linkedin.com/in/${slug}`;
          result.bio = top.snippet ?? undefined;
        }
      }
    }
  } catch { /* ignore */ }

  try {
    const q = context.company
      ? `site:x.com "${context.name}" "${context.company}"`
      : `site:x.com "${context.name}"`;
    const res = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(q)}&api_key=${SERPAPI_KEY}&num=3`);
    if (res.ok) {
      const data = await res.json() as { organic_results?: Array<{ link?: string }> };
      const top = data.organic_results?.[0];
      if (top?.link) {
        const handle = top.link.match(/(?:x|twitter)\.com\/([^/?#]+)/i)?.[1];
        if (handle && handle !== "i" && handle !== "search") {
          result.twitter_handle = handle;
          result.twitter_url = `https://x.com/${handle}`;
        }
      }
    }
  } catch { /* ignore */ }

  return result;
}

// ── Main enrichment ───────────────────────────────────────────────────────────
export const enrichmentService = {
  async enrichContact(contactId: string) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: { platforms: true },
    });
    if (!contact) throw new Error("Contact not found");

    const linkedinPlatform = contact.platforms.find((p) => p.type === "linkedin");
    const xPlatform        = contact.platforms.find((p) => p.type === "x");

    // Single web search call gets everything at once
    const found = await webSearchEnrich({
      name: contact.name,
      company: contact.company,
      role: contact.role,
    });

    // ── Build contact update ──────────────────────────────────────────────────
    const updateData: Record<string, unknown> = {};

    if (found.role)     updateData.role = found.role;
    if (found.company)  updateData.company = found.company;

    // Only update name if current name looks like a handle/placeholder
    if (found.full_name) {
      const looksLikePlaceholder =
        contact.name.includes("|") ||
        contact.name.includes("@") ||
        contact.name.match(/^[a-z0-9_]+$/i) ||
        contact.name.length <= 4;
      if (looksLikePlaceholder) updateData.name = found.full_name;
    }

    // ── Company record ────────────────────────────────────────────────────────
    const finalCompany = found.company || contact.company;
    let companyRecord = null;
    if (finalCompany) {
      const companyData: Record<string, any> = {};
      if (found.company_website)     companyData.website     = found.company_website;
      if (found.company_description) companyData.description = found.company_description;
      if (found.company_linkedin)    companyData.linkedin    = found.company_linkedin;
      if (found.company_sector)      companyData.sector      = found.company_sector;
      if (found.company_size)        companyData.size        = found.company_size;
      if (found.company_funding)     companyData.funding     = found.company_funding;

      const existingCompany = await prisma.company.findFirst({
        where: { userId: contact.userId, name: finalCompany },
      });

      if (existingCompany) {
        companyRecord = await prisma.company.update({
          where: { id: existingCompany.id },
          data: companyData,
        });
      } else {
        companyRecord = await prisma.company.create({
          data: { name: finalCompany, userId: contact.userId, ...companyData },
        });
      }
      if (!contact.companyId) updateData.companyId = companyRecord.id;
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.contact.update({ where: { id: contactId }, data: updateData });
    }

    // ── Persist new platforms ─────────────────────────────────────────────────
    const platformsAdded: Array<{ type: string; platformId: string; profileUrl?: string }> = [];

    if (found.linkedin_slug && !linkedinPlatform) {
      try {
        const existing = await prisma.platform.findFirst({
          where: { type: "linkedin", platformId: found.linkedin_slug },
        });
        if (existing) {
          if (existing.contactId !== contactId)
            await prisma.platform.update({ where: { id: existing.id }, data: { contactId } });
        } else {
          await prisma.platform.create({
            data: {
              contactId,
              type: "linkedin",
              platformId: found.linkedin_slug,
              profileUrl: found.linkedin_url ?? null,
              displayName: found.full_name ?? contact.name,
            },
          });
        }
        platformsAdded.push({ type: "linkedin", platformId: found.linkedin_slug, profileUrl: found.linkedin_url });
      } catch (err) {
        console.error("[enrichment] LinkedIn platform save failed:", err);
      }
    }

    if (found.twitter_handle && !xPlatform) {
      try {
        const existing = await prisma.platform.findFirst({
          where: { type: "x", platformId: found.twitter_handle },
        });
        if (existing) {
          if (existing.contactId !== contactId)
            await prisma.platform.update({ where: { id: existing.id }, data: { contactId } });
        } else {
          await prisma.platform.create({
            data: {
              contactId,
              type: "x",
              platformId: found.twitter_handle,
              profileUrl: found.twitter_url ?? null,
              displayName: found.twitter_handle,
            },
          });
        }
        platformsAdded.push({ type: "x", platformId: found.twitter_handle, profileUrl: found.twitter_url });
      } catch (err) {
        console.error("[enrichment] X platform save failed:", err);
      }
    }

    // ── Post-enrichment AI summary + classification ───────────────────────────
    const updatedContact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        platforms: true,
        interactions: { orderBy: { occurredAt: "desc" }, take: 20 },
        notes: { orderBy: { createdAt: "desc" }, take: 10 },
        contactTags: { include: { tag: true } },
      },
    });

    if (updatedContact) {
      try {
        const newSummary = await aiService.generateSummary(updatedContact);
        if (newSummary) {
          await prisma.contact.update({
            where: { id: contactId },
            data: { aiSummary: newSummary },
          });
        }
      } catch (err) {
        console.error("[enrichment] Summary generation failed:", err);
      }

      try {
        const classResult = await aiService.classifyContact(updatedContact);
        await prisma.contact.update({
          where: { id: contactId },
          data: {
            type: sanitizeType(classResult.type) as any,
            domain: sanitizeDomain(classResult.domain) as any,
          },
        });
      } catch (err) {
        console.error("[enrichment] Classification failed:", err);
      }
    }

    await cache.invalidateContacts().catch(console.error);

    return {
      contactId,
      enrichedData: found,
      companyLinked: companyRecord ? { id: companyRecord.id, name: companyRecord.name } : null,
      platformsAdded,
    };
  },
};
