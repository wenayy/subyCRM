import { Queue } from "bullmq";
import { redisConnection } from "./redis";

export const QUEUE_NAMES = {
  AI_CLASSIFY: "ai-classify",
  AI_SUMMARY: "ai-summary",
  AI_PREP: "ai-prep",
  VOICE_CAPTURE: "voice-capture",
  ENRICH_CONTACT: "enrich-contact",
  SEQUENCE_TICK: "sequence-tick",
  DAILY_BRIEF: "daily-brief",
  OUTCOME_PROMPT: "outcome-prompt",
  GMAIL_SYNC: "gmail-sync",
  X_DM_SYNC: "x-dm-sync",
  SLACK_SYNC: "slack-sync",
  DISCORD_SYNC: "discord-sync",
  CSV_IMPORT: "csv-import",
  LINKEDIN_SYNC: "linkedin-sync",
  WHATSAPP_IMPORT: "whatsapp-import",
  TELEGRAM_IMPORT: "telegram-import",
  WHATSAPP_SEND: "whatsapp-send",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const queues = {
  aiClassify: new Queue(QUEUE_NAMES.AI_CLASSIFY, redisConnection),
  aiSummary: new Queue(QUEUE_NAMES.AI_SUMMARY, redisConnection),
  aiPrep: new Queue(QUEUE_NAMES.AI_PREP, redisConnection),
  voiceCapture: new Queue(QUEUE_NAMES.VOICE_CAPTURE, redisConnection),
  enrichContact: new Queue(QUEUE_NAMES.ENRICH_CONTACT, redisConnection),
  sequenceTick: new Queue(QUEUE_NAMES.SEQUENCE_TICK, redisConnection),
  dailyBrief: new Queue(QUEUE_NAMES.DAILY_BRIEF, redisConnection),
  outcomePrompt: new Queue(QUEUE_NAMES.OUTCOME_PROMPT, redisConnection),
  gmailSync: new Queue(QUEUE_NAMES.GMAIL_SYNC, redisConnection),
  xDmSync: new Queue(QUEUE_NAMES.X_DM_SYNC, redisConnection),
  slackSync: new Queue(QUEUE_NAMES.SLACK_SYNC, redisConnection),
  discordSync: new Queue(QUEUE_NAMES.DISCORD_SYNC, redisConnection),
  csvImport: new Queue(QUEUE_NAMES.CSV_IMPORT, redisConnection),
  linkedinSync: new Queue(QUEUE_NAMES.LINKEDIN_SYNC, redisConnection),
  whatsappImport: new Queue(QUEUE_NAMES.WHATSAPP_IMPORT, redisConnection),
  telegramImport: new Queue(QUEUE_NAMES.TELEGRAM_IMPORT, redisConnection),
  whatsappSend: new Queue(QUEUE_NAMES.WHATSAPP_SEND, redisConnection),
};

/** Default job options for all queues */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
};
