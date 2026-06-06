import { prisma } from "../src/server/lib/prisma";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

console.log("OPENAI_API_KEY present:", !!process.env.OPENAI_API_KEY);
console.log("ANTHROPIC_API_KEY present:", !!process.env.ANTHROPIC_API_KEY);
