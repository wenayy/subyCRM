import { prisma } from "../lib/prisma";
import OpenAI from "openai";
import { aiService, sanitizeType, sanitizeDomain } from "./ai.service";
import { cache } from "../lib/cache";

const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

interface SerpCandidate {
  title: string;
  snippet: string;
  link: string;
}

interface SerpResult {
  organic_results?: Array<{ title?: string; snippet?: string; link?: string }>;
}

async function serpSearch(query: string): Promise<SerpCandidate[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("num", "5");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  const data = (await res.json()) as SerpResult;
  return (data.organic_results ?? [])
    .filter((r) => r.title && r.snippet && r.link)
    .map((r) => ({ title: r.title!, snippet: r.snippet!, link: r.link! }));
}

// ── AI verification: pick the right result from candidates ────────────────────
interface AIMatch {
  matched: boolean;
  profileId?: string;       // slug from URL (linkedin) or handle (x)
  profileUrl?: string;
  fullName?: string;
  role?: string;
  company?: string;
  bio?: string;
  followers?: string;
}

async function aiPickBestMatch(
  platform: "linkedin" | "x",
  candidates: SerpCandidate[],
  context: { name: string; company?: string | null; role?: string | null; xHandle?: string | null },
): Promise<AIMatch> {
  if (candidates.length === 0) return { matched: false };

  const candidateLines = candidates.map((c, i) =>
    `[${i}] URL: ${c.link}\n    Title: ${c.title}\n    Snippet: ${c.snippet}`,
  ).join("\n\n");

  const contextStr = [
    `Name: ${context.name}`,
    context.company ? `Company: ${context.company}` : null,
    context.role ? `Role: ${context.role}` : null,
    context.xHandle ? `X/Twitter handle: @${context.xHandle}` : null,
  ].filter(Boolean).join(", ");

  const prompt = platform === "linkedin"
    ? `You are verifying LinkedIn search results. The person is: ${contextStr}.

Below are ${candidates.length} Google search results for this person on LinkedIn.
Pick the ONE result that is definitely this specific person's LinkedIn profile.
If none are a confident match, return matched=false.

CRITICAL: The name of the person in the search result MUST match or be a close variation/nickname of the contact's name (e.g. "Gaspard" or "Suby" is acceptable for "Gap | Suby", but a completely different name like "Damon Berger" is NOT a match). If the names are completely different, you MUST return matched=false.

Results:
${candidateLines}

Return ONLY valid JSON, no markdown:
{
  "matched": true/false,
  "resultIndex": <0-based index or null>,
  "fullName": "<name from title>",
  "role": "<job title extracted from title or snippet>",
  "company": "<company from title or snippet>",
  "bio": "<full snippet text of best result — do not truncate>",
  "profileId": "<linkedin username slug from URL>"
}`
    : `You are verifying X/Twitter search results. The person is: ${contextStr}.

Below are ${candidates.length} Google search results for this person on X/Twitter.
Pick the ONE result that is definitely this person's X profile.
If none are a confident match, return matched=false.

CRITICAL: The name or handle in the search result MUST match or be a close variation of the contact's name. If the result is for a completely different person, you MUST return matched=false.

Results:
${candidateLines}

Return ONLY valid JSON, no markdown:
{
  "matched": true/false,
  "resultIndex": <0-based index or null>,
  "handle": "<twitter/x username without @>",
  "fullName": "<name from title or bio>",
  "role": "<job title / role like Co-founder, Founder, Engineer, etc. or null>",
  "company": "<company name like Suby, Vercel, etc. or null>",
  "bio": "<full snippet text>",
  "followers": "<e.g. 12.4K Followers or null>"
}`;

  try {
    const resp = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    });
    const out = JSON.parse(resp.choices[0].message.content ?? "{}");
    if (!out.matched) return { matched: false };

    // Extra safety: double check the name difference
    if (platform === "linkedin" && out.fullName) {
      const contactWords = context.name.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length > 1);
      const matchWords = out.fullName.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length > 1);

      const hasWordOverlap = contactWords.some((cw: string) => matchWords.some((mw: string) => mw.includes(cw) || cw.includes(mw)));
      if (!hasWordOverlap) {
        console.warn(`[enrichment] AI matched a completely different name: "${out.fullName}" for contact "${context.name}". Rejecting.`);
        return { matched: false };
      }
    }

    const chosen = typeof out.resultIndex === "number" ? candidates[out.resultIndex] : null;

    if (platform === "linkedin") {
      // Extract real profile slug from the actual URL (don't trust AI-hallucinated URLs)
      const urlSlug = chosen?.link.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
      return {
        matched: true,
        profileId: urlSlug ?? out.profileId,
        profileUrl: urlSlug ? `https://www.linkedin.com/in/${urlSlug}` : undefined,
        fullName: out.fullName || undefined,
        role: out.role || undefined,
        company: out.company || undefined,
        bio: out.bio || chosen?.snippet || undefined,
      };
    } else {
      // Extract real handle from the actual URL
      const urlHandle = chosen?.link.match(/(?:x|twitter)\.com\/([^/?#]+)/i)?.[1];
      const handle = urlHandle && urlHandle !== "i" && urlHandle !== "search"
        ? urlHandle
        : out.handle;
      return {
        matched: !!handle,
        profileId: handle,
        profileUrl: handle ? `https://x.com/${handle}` : undefined,
        fullName: out.fullName || undefined,
        role: out.role || undefined,
        company: out.company || undefined,
        bio: out.bio || chosen?.snippet || undefined,
        followers: out.followers || undefined,
      };
    }
  } catch (err) {
    console.error("[enrichment] AI pick failed:", err);
    return { matched: false };
  }
}

async function enrichCompanyDetails(companyName: string) {
  try {
    const q = `"${companyName}" company profile website`;
    const candidates = await serpSearch(q);
    if (candidates.length === 0) return null;

    const candidateLines = candidates.map((c, i) =>
      `[${i}] URL: ${c.link}\n    Title: ${c.title}\n    Snippet: ${c.snippet}`
    ).join("\n\n");

    const prompt = `You are extracting information about a company called "${companyName}".
Below are Google search results. Pick the best result to extract company information.
If none of the results match this company, return matched=false.

Allowed sectors: payment, blockchain, saas, ecommerce, ai, marketing, legal, finance, other.
Allowed sizes: startup, scaleup, enterprise.

Results:
${candidateLines}

Return ONLY valid JSON:
{
  "matched": true,
  "website": "<official company homepage URL or null>",
  "linkedin": "<linkedin company URL or null>",
  "description": "<1-2 sentence description of what they do or null>",
  "sector": "<one of the allowed sectors or null>",
  "size": "<one of the allowed sizes or null>",
  "funding": "<e.g. seed, series-a, public, or null>"
}`;

    const resp = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const out = JSON.parse(resp.choices[0].message.content ?? "{}");
    if (!out.matched) return null;

    return {
      website: out.website || undefined,
      linkedin: out.linkedin || undefined,
      description: out.description || undefined,
      sector: out.sector ? out.sector.toLowerCase().trim() : undefined,
      size: out.size ? out.size.toLowerCase().trim() : undefined,
      funding: out.funding || undefined,
    };
  } catch (err) {
    console.error(`[enrichment] Company details enrichment failed for ${companyName}:`, err);
    return null;
  }
}

// ── Main enrichment ───────────────────────────────────────────────────────────
export const enrichmentService = {
  async enrichContact(contactId: string) {
    // Fail fast with a clear reason — otherwise missing keys surface as a
    // silent "no confident match" and enrichment looks broken for no reason.
    if (!SERPAPI_KEY) throw new Error("Enrichment unavailable: SERPAPI_KEY is not set");
    if (!process.env.OPENAI_API_KEY) throw new Error("Enrichment unavailable: OPENAI_API_KEY is not set");

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: { platforms: true },
    });
    if (!contact) throw new Error("Contact not found");

    const linkedinPlatform = contact.platforms.find((p) => p.type === "linkedin");
    const xPlatform        = contact.platforms.find((p) => p.type === "x");

    const enrichedData: {
      fullName?: string; company?: string; role?: string; bio?: string;
      followers?: string; linkedinSnippet?: string; twitterSnippet?: string;
    } = {};

    // ── Step 1: X/Twitter (usually more accurate — handles are unique) ────────
    let twitterMatch: AIMatch = { matched: false };
    if (!xPlatform) {
      try {
        const q = contact.company
          ? `site:x.com "${contact.name}" "${contact.company}"`
          : `site:x.com "${contact.name}"`;
        const candidates = await serpSearch(q);
        twitterMatch = await aiPickBestMatch("x", candidates, {
          name: contact.name,
          company: contact.company,
          role: contact.role,
        });
        if (twitterMatch.matched) {
          if (twitterMatch.bio)       enrichedData.twitterSnippet = twitterMatch.bio;
          if (twitterMatch.followers) enrichedData.followers = twitterMatch.followers;
          if (twitterMatch.fullName)  enrichedData.fullName = twitterMatch.fullName;
          if (twitterMatch.role)      enrichedData.role = twitterMatch.role;
          if (twitterMatch.company)   enrichedData.company = twitterMatch.company;
          console.log(`[enrichment] X matched: @${twitterMatch.profileId}`);
        } else {
          console.log("[enrichment] X: no confident match found");
        }
      } catch (err) {
        console.error("[enrichment] X search failed:", err);
      }
    } else {
      // Already have X — fetch details to get role/company/followers
      try {
        const candidates = await serpSearch(`site:x.com "${xPlatform.platformId}"`);
        twitterMatch = await aiPickBestMatch("x", candidates, {
          name: contact.name,
          company: contact.company,
          role: contact.role,
          xHandle: xPlatform.platformId,
        });
        if (twitterMatch.matched) {
          if (twitterMatch.bio)       enrichedData.twitterSnippet = twitterMatch.bio;
          if (twitterMatch.followers) enrichedData.followers = twitterMatch.followers;
          if (twitterMatch.fullName)  enrichedData.fullName = twitterMatch.fullName;
          if (twitterMatch.role)      enrichedData.role = twitterMatch.role;
          if (twitterMatch.company)   enrichedData.company = twitterMatch.company;
        }
      } catch (err) {
        console.error("[enrichment] Already-had-X search/parse failed:", err);
      }
    }

    // ── Step 2: LinkedIn (use X handle as extra signal if just found) ─────────
    let linkedinMatch: AIMatch = { matched: false };
    if (!linkedinPlatform) {
      try {
        // Build a precise query using every signal we have
        const knownHandle = xPlatform?.platformId ?? (twitterMatch.matched ? twitterMatch.profileId : null);
        let q: string;
        if (contact.company && contact.role) {
          q = `site:linkedin.com/in "${contact.name}" "${contact.company}" "${contact.role}"`;
        } else if (contact.company) {
          q = `site:linkedin.com/in "${contact.name}" "${contact.company}"`;
        } else {
          q = `site:linkedin.com/in "${contact.name}"`;
        }
        const candidates = await serpSearch(q);
        linkedinMatch = await aiPickBestMatch("linkedin", candidates, {
          name: contact.name,
          company: contact.company,
          role: contact.role,
          xHandle: knownHandle ?? null,
        });
        if (linkedinMatch.matched) {
          if (linkedinMatch.fullName) enrichedData.fullName = linkedinMatch.fullName;
          if (linkedinMatch.company)  enrichedData.company  = linkedinMatch.company;
          if (linkedinMatch.role)     enrichedData.role     = linkedinMatch.role;
          if (linkedinMatch.bio)      enrichedData.linkedinSnippet = linkedinMatch.bio;
          console.log(`[enrichment] LinkedIn matched: ${linkedinMatch.profileId} (${linkedinMatch.role} @ ${linkedinMatch.company})`);
        } else {
          console.log("[enrichment] LinkedIn: no confident match found");
        }
      } catch (err) {
        console.error("[enrichment] LinkedIn search failed:", err);
      }
    } else {
      // Already have LinkedIn — re-fetch snippet & full details
      try {
        const candidates = await serpSearch(`site:linkedin.com/in "${linkedinPlatform.platformId}"`);
        linkedinMatch = await aiPickBestMatch("linkedin", candidates, {
          name: contact.name,
          company: contact.company,
          role: contact.role,
        });
        if (linkedinMatch.matched) {
          if (linkedinMatch.fullName) enrichedData.fullName = linkedinMatch.fullName;
          if (linkedinMatch.company)  enrichedData.company  = linkedinMatch.company;
          if (linkedinMatch.role)     enrichedData.role     = linkedinMatch.role;
          if (linkedinMatch.bio)      enrichedData.linkedinSnippet = linkedinMatch.bio;
        }
      } catch (err) {
        console.error("[enrichment] Already-had-LinkedIn search/parse failed:", err);
      }
    }

    // ── Persist updates ───────────────────────────────────────────────────────
    const updateData: Record<string, unknown> = {};

    // Prioritize LinkedIn metadata but fall back to Twitter/X if LinkedIn is missing
    const finalName    = linkedinMatch.fullName ?? twitterMatch.fullName;
    const finalRole    = linkedinMatch.role    ?? twitterMatch.role;
    const finalCompany = linkedinMatch.company ?? twitterMatch.company;

    if (finalRole)    updateData.role    = finalRole;
    if (finalCompany) updateData.company = finalCompany;

    if (finalName) {
      const isPlaceholderOrHandle =
        contact.name.includes("|") ||
        contact.name.includes("@") ||
        contact.name.match(/^[a-z0-9_]+$/i) ||
        contact.name.length <= 4;
      if (isPlaceholderOrHandle) {
        updateData.name = finalName;
      }
    }

    let companyRecord = null;
    if (finalCompany) {
      const existingCompany = await prisma.company.findFirst({
        where: { userId: contact.userId, name: finalCompany },
      });

      let companyUpdateData: Record<string, any> = {};
      if (!existingCompany || !existingCompany.description || !existingCompany.website) {
        const companyDetails = await enrichCompanyDetails(finalCompany);
        if (companyDetails) {
          companyUpdateData = companyDetails;
        }
      }

      if (existingCompany) {
        companyRecord = await prisma.company.update({
          where: { id: existingCompany.id },
          data: companyUpdateData,
        });
      } else {
        companyRecord = await prisma.company.create({
          data: { name: finalCompany, userId: contact.userId, ...companyUpdateData },
        });
      }
      if (!contact.companyId) updateData.companyId = companyRecord.id;
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.contact.update({ where: { id: contactId }, data: updateData });
    }

    // ── Persist new platforms ─────────────────────────────────────────────────
    const platformsAdded: Array<{ type: string; platformId: string; profileUrl?: string }> = [];

    if (linkedinMatch.matched && linkedinMatch.profileId && !linkedinPlatform) {
      try {
        const existing = await prisma.platform.findFirst({
          where: { type: "linkedin", platformId: linkedinMatch.profileId, contact: { userId: contact.userId } },
        });
        if (existing) {
          if (existing.contactId !== contactId)
            await prisma.platform.update({ where: { id: existing.id }, data: { contactId } });
        } else {
          await prisma.platform.create({
            data: {
              contactId,
              type: "linkedin",
              platformId: linkedinMatch.profileId,
              profileUrl: linkedinMatch.profileUrl ?? null,
              displayName: linkedinMatch.fullName ?? contact.name,
            },
          });
        }
        platformsAdded.push({ type: "linkedin", platformId: linkedinMatch.profileId, profileUrl: linkedinMatch.profileUrl });
      } catch (err) {
        console.error("[enrichment] LinkedIn platform save failed:", err);
      }
    }

    if (twitterMatch.matched && twitterMatch.profileId && !xPlatform) {
      try {
        const existing = await prisma.platform.findFirst({
          where: { type: "x", platformId: twitterMatch.profileId, contact: { userId: contact.userId } },
        });
        if (existing) {
          if (existing.contactId !== contactId)
            await prisma.platform.update({ where: { id: existing.id }, data: { contactId } });
        } else {
          await prisma.platform.create({
            data: {
              contactId,
              type: "x",
              platformId: twitterMatch.profileId,
              profileUrl: twitterMatch.profileUrl ?? null,
              displayName: twitterMatch.profileId,
            },
          });
        }
        platformsAdded.push({ type: "x", platformId: twitterMatch.profileId, profileUrl: twitterMatch.profileUrl });
      } catch (err) {
        console.error("[enrichment] X platform save failed:", err);
      }
    }

    // ── Post-enrichment classification and summary ────────────────────────────
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
          enrichedData.bio = newSummary;
        }
      } catch (err) {
        console.error("[enrichment] Failed to generate summary after enrichment:", err);
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
        console.error("[enrichment] Failed to classify contact after enrichment:", err);
      }
    }

    await cache.invalidateContacts().catch(console.error);

    return {
      contactId,
      enrichedData,
      companyLinked: companyRecord ? { id: companyRecord.id, name: companyRecord.name } : null,
      platformsAdded,
    };
  },
};
