import path from "path";
import fs from "fs/promises";

// Durable media storage backed by Supabase Storage.
//
// Railway's filesystem is ephemeral (wiped on every deploy) and media can be
// downloaded by whichever server synced the message (local dev vs prod), so
// files written only to public/media break for everyone else. This module
// keeps the local file as a fast cache but also uploads to a public Supabase
// bucket, and lets readers pull missing files back down from the bucket.
// URLs in message bodies stay relative (/media/<name>) everywhere.

const BUCKET = "media";

function supabaseUrl(): string | null {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL.replace(/\/$/, "");
  // Derive from DATABASE_URL: postgres.<ref>@... (pooler) or db.<ref>.supabase.co
  const db = process.env.DATABASE_URL ?? "";
  const ref = db.match(/postgres\.([a-z0-9]+)[:@]/)?.[1] ?? db.match(/db\.([a-z0-9]+)\.supabase\.co/)?.[1];
  return ref ? `https://${ref}.supabase.co` : null;
}

function serviceKey(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null;
}

export function bucketEnabled(): boolean {
  return !!(supabaseUrl() && serviceKey());
}

let bucketEnsured = false;
async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const res = await fetch(`${supabaseUrl()}/storage/v1/bucket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  // 200 = created; 400/409 = already exists — both fine
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    const body = await res.text().catch(() => "");
    console.error(`[media-store] bucket create failed (${res.status}): ${body}`);
    return;
  }
  bucketEnsured = true;
}

function localMediaDir(): string {
  return path.join(process.cwd(), "public", "media");
}

// Write media locally (fast cache) and to the Supabase bucket (durable).
// Returns the relative URL used in message bodies.
export async function saveMedia(buffer: Buffer, uniqueName: string, mimeType: string): Promise<string> {
  const dir = localMediaDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, uniqueName), buffer);

  if (bucketEnabled()) {
    try {
      await ensureBucket();
      const res = await fetch(`${supabaseUrl()}/storage/v1/object/${BUCKET}/${encodeURIComponent(uniqueName)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey()}`, "Content-Type": mimeType, "x-upsert": "true" },
        body: new Uint8Array(buffer),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[media-store] bucket upload failed for ${uniqueName} (${res.status}): ${body}`);
      }
    } catch (e: any) {
      console.error(`[media-store] bucket upload error for ${uniqueName}:`, e?.message);
    }
  }
  return `/media/${uniqueName}`;
}

async function fetchFromBucket(uniqueName: string): Promise<Buffer | null> {
  if (!bucketEnabled()) return null;
  try {
    const res = await fetch(`${supabaseUrl()}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(uniqueName)}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Make sure a media file exists on the local disk, pulling it from the bucket
// if needed (e.g. it was synced by a different server or wiped by a redeploy).
export async function ensureMediaLocal(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch { /* not local — try the bucket */ }
  const buf = await fetchFromBucket(path.basename(filePath));
  if (!buf) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buf);
  console.log(`[media-store] restored ${path.basename(filePath)} from bucket (${buf.length} bytes)`);
  return true;
}
