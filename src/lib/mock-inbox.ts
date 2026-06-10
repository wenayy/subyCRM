import type { PlatformType } from "./types";
import { MOCK_CONTACTS } from "./mock-contacts";

export interface InboxMessage {
  id: string;
  platform: PlatformType;
  contactId: string;
  contactName: string;
  preview: string;
  body: string;
  receivedAt: string;
  read: boolean;
  starred: boolean;
}

const ago = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function findContact(id: string) {
  const c = MOCK_CONTACTS.find((x) => x.id === id);
  return c ? { contactId: c.id, contactName: c.name } : { contactId: id, contactName: "Unknown" };
}

export const MOCK_INBOX: InboxMessage[] = [
  {
    id: "msg-1",
    platform: "telegram",
    ...findContact("c-stripe-1"),
    preview: "Salut Gaspard, peux-tu m'envoyer la version finale de la deck ?",
    body: "Salut Gaspard,\n\nPeux-tu m'envoyer la version finale de la deck on the EU rails ? On a call interne demain et j'aimerais la partager.\n\nThanks,\nPatrick",
    receivedAt: ago(0.4),
    read: false,
    starred: true,
  },
  {
    id: "msg-2",
    platform: "x",
    ...findContact("c-mistral-1"),
    preview: "DM: Confirme bien le quota pour le contrat",
    body: "Confirmed for the 100M tokens/month. Send the contract whenever you can.",
    receivedAt: ago(2),
    read: false,
    starred: false,
  },
  {
    id: "msg-3",
    platform: "email",
    ...findContact("c-cb-2"),
    preview: "Re: Suby × Coinbase · Executive summary",
    body: "Hi Gaspard,\n\nThanks for sending the deck. The team had a few questions on the merchant onboarding flow · would Wednesday 9:30am ET work for a quick call?\n\nBest,\nEmilie",
    receivedAt: ago(5),
    read: false,
    starred: false,
  },
  {
    id: "msg-4",
    platform: "linkedin",
    ...findContact("c-aglae-2"),
    preview: "Free for coffee next Thursday?",
    body: "Hi! We said we'd meet up this month. Free next Thursday around 10am? Otherwise just throw me some other slots.",
    receivedAt: ago(8),
    read: true,
    starred: false,
  },
  {
    id: "msg-5",
    platform: "discord",
    ...findContact("c-vercel-2"),
    preview: "@you posted a meme about Next 16 caching",
    body: "lol fair point · let me ping the team. Btw if you're building on the new cache components we'd love feedback.",
    receivedAt: ago(11),
    read: true,
    starred: false,
  },
  {
    id: "msg-6",
    platform: "telegram",
    ...findContact("c-ledger-1"),
    preview: "MOU received, on revient sous 48h",
    body: "Got it, we'll come back within 48h after the legal review. Still on for Tuesday's call?",
    receivedAt: ago(20),
    read: true,
    starred: false,
  },
  {
    id: "msg-7",
    platform: "x",
    ...findContact("c-hf-1"),
    preview: "Reply: cool, on prend langue lundi !",
    body: "Cool, on prend langue lundi alors !",
    receivedAt: ago(26),
    read: true,
    starred: false,
  },
  {
    id: "msg-8",
    platform: "email",
    ...findContact("c-seq-3"),
    preview: "Investor update: Q1 numbers look strong",
    body: "Thanks for the update Gaspard, numbers look strong. Curious about the churn breakdown · can you share more color on that?",
    receivedAt: ago(36),
    read: true,
    starred: true,
  },
  {
    id: "msg-9",
    platform: "telegram",
    ...findContact("c-linear-1"),
    preview: "moved to thursday 16:00, works for you?",
    body: "moved to thursday 16:00, works for you?",
    receivedAt: ago(50),
    read: true,
    starred: false,
  },
  {
    id: "msg-10",
    platform: "linkedin",
    ...findContact("c-qonto-1"),
    preview: "Connected. Looking forward to the partnership review",
    body: "Connected. Looking forward to the partnership review.",
    receivedAt: ago(72),
    read: true,
    starred: false,
  },
];
