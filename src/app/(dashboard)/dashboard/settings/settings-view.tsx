"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { calendarApi, gmailApi, discordApi, slackApi, xApi, whatsappApi, telegramPersonalApi, linkedinApi } from "@/lib/api";

type Status = "connected" | "disconnected" | "error";

interface IntegrationDef {
  key: string;
  name: string;
  description: string;
  color: string;
  bg: string;
  iconPath: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    key: "subyassist_bot",
    name: "@subyassistant_bot",
    description: "Telegram voice bot. Send voice notes → Whisper transcribes → GPT creates notes/reminders/strength bumps on matching contacts.",
    color: "#229ED9", bg: "#229ED915",
    iconPath: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.44 3.8-1.58 4.59-1.86 5.1-1.87.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z",
  },
  {
    key: "google_calendar",
    name: "Google Calendar",
    description: "Sync your calendar to pre-call view. Detects upcoming meetings and links them to contacts.",
    color: "#4285F4", bg: "#4285F415",
    iconPath: "M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z",
  },
  {
    key: "gmail",
    name: "Gmail",
    description: "Index emails from key contacts and surface them in the contact timeline and unified inbox.",
    color: "#EA4335", bg: "#EA433515",
    iconPath: "M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z",
  },
  {
    key: "telegram_personal",
    name: "Telegram (Personal)",
    description: "Read all your personal Telegram DMs — not just messages to the bot. Requires API credentials from my.telegram.org.",
    color: "#229ED9", bg: "#229ED915",
    iconPath: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.44 3.8-1.58 4.59-1.86 5.1-1.87.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z",
  },
  {
    key: "whatsapp",
    name: "WhatsApp",
    description: "Scan a QR code (like WhatsApp Web) to capture all incoming DMs and match them to contacts.",
    color: "#25D366", bg: "#25D36615",
    iconPath: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12 2C6.478 2 2 6.478 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.93 9.93 0 0012 22c5.522 0 10-4.478 10-10S17.522 2 12 2z",
  },
  {
    key: "slack",
    name: "Slack",
    description: "Connect workspaces to log DMs with partners and investors in the unified inbox.",
    color: "#E01E5A", bg: "#E01E5A15",
    iconPath: "M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z",
  },
  {
    key: "discord",
    name: "Discord",
    description: "Add your bot token to track DMs and server messages from founders & devs you talk to.",
    color: "#5865F2", bg: "#5865F215",
    iconPath: "M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z",
  },
  {
    key: "x",
    name: "X / Twitter",
    description: "Read DMs from founders and investors. Connect via OAuth — requires an X Developer app with DM access.",
    color: "var(--t1)", bg: "var(--al)",
    iconPath: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  },
  {
    key: "linkedin",
    name: "LinkedIn",
    description: "Connect your LinkedIn profile for contact enrichment. Click Connect and authorize in one step.",
    color: "#0A66C2", bg: "#0A66C215",
    iconPath: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  },
];

const STATUS_META: Record<Status, { label: string; bg: string; color: string; dot: string }> = {
  connected: { label: "Connected", bg: "var(--gb)", color: "var(--gc)", dot: "var(--gc)" },
  disconnected: { label: "Not connected", bg: "var(--al)", color: "var(--t3)", dot: "var(--bd2)" },
  error: { label: "Reconnect", bg: "var(--rb)", color: "var(--rc)", dot: "var(--rc)" },
};

const GROUPS = [
  { label: "Voice assistant", keys: ["subyassist_bot"] },
  { label: "Calendar & Email", keys: ["google_calendar", "gmail"] },
  { label: "Messaging", keys: ["whatsapp", "telegram_personal", "slack", "discord"] },
  { label: "Social", keys: ["x", "linkedin"] },
];

// ─── Per-integration connect modals ──────────────────────────────────────────

function DiscordModal({ onConnect, onClose }: { onConnect: (token: string) => Promise<void>; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!token.trim()) return;
    setLoading(true); setError("");
    try { await onConnect(token.trim()); onClose(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : "Failed"); }
    finally { setLoading(false); }
  };
  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Connect Discord</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <p className="text-xs text-muted-foreground leading-normal">
            1. Go to <strong>discord.com/developers/applications</strong><br />
            2. Create an application → Bot → Copy the bot token<br />
            3. Invite the bot to your server with <code>View Messages</code> permission
          </p>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bot token (e.g. MTIz...)"
            className="w-full px-3 py-1.5 text-sm rounded-lg border border-border bg-muted/50 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {error && <p className="text-status-red text-xs">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end mt-2">
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={loading || !token.trim()}>{loading && <Spinner />}{loading ? "Connecting…" : "Connect"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function XModal({ hasEnvCreds, onConnect, onClose }: {
  hasEnvCreds?: boolean;
  onConnect: (d: { accessToken: string; accessTokenSecret: string; apiKey?: string; apiSecret?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState({ apiKey: "", apiSecret: "", accessToken: "", accessTokenSecret: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((p) => ({ ...p, [k]: e.target.value }));
  
  const submit = async () => {
    if (!form.accessToken || !form.accessTokenSecret) { setError("Access token and secret required"); return; }
    if (!hasEnvCreds && (!form.apiKey || !form.apiSecret)) { setError("API Key and Secret required"); return; }
    
    setLoading(true); setError("");
    try {
      await onConnect({
        accessToken: form.accessToken.trim(),
        accessTokenSecret: form.accessTokenSecret.trim(),
        ...(hasEnvCreds ? {} : { apiKey: form.apiKey.trim(), apiSecret: form.apiSecret.trim() }),
      });
      onClose();
    }
    catch (e: unknown) { setError(e instanceof Error ? e.message : "Failed"); }
    finally { setLoading(false); }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[400px] rounded-2xl p-6">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold text-foreground">Connect X / Twitter</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {hasEnvCreds ? (
            <p className="text-xs text-muted-foreground leading-relaxed">
              API credentials are pre-configured on the server. Please enter your account <strong>Access Token</strong> and <strong>Access Token Secret</strong> from <strong>developer.twitter.com</strong> (Keys and Tokens) to connect:
            </p>
          ) : (
            <p className="text-xs text-muted-foreground leading-normal">
              Get API keys from <strong>developer.twitter.com</strong> → Your App → Keys and Tokens
            </p>
          )}

          <div className="space-y-3">
            {!hasEnvCreds && (
              <>
                <input
                  value={form.apiKey}
                  onChange={set("apiKey")}
                  placeholder="API Key"
                  className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60"
                />
                <input
                  value={form.apiSecret}
                  onChange={set("apiSecret")}
                  placeholder="API Secret"
                  className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60"
                />
              </>
            )}
            <input
              value={form.accessToken}
              onChange={set("accessToken")}
              placeholder="Access Token"
              className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60"
            />
            <input
              value={form.accessTokenSecret}
              onChange={set("accessTokenSecret")}
              placeholder="Access Token Secret"
              className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60"
            />
          </div>
          {error && <p className="text-status-red text-xs mt-1 bg-status-red/10 px-3 py-1.5 rounded-lg font-medium">{error}</p>}
        </div>
        <div className="flex gap-2.5 justify-end mt-2">
          <Button size="sm" variant="outline" className="rounded-xl px-4" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="rounded-xl px-4" onClick={submit} disabled={loading}>{loading && <Spinner />}{loading ? "Connecting…" : "Connect"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TelegramPersonalModal({ hasEnvCreds, onClose }: { hasEnvCreds?: boolean; onClose: () => void }) {
  const [step, setStep] = useState<"credentials" | "auth">(hasEnvCreds ? "auth" : "credentials");
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  
  // Login method selector
  const [loginMethod, setLoginMethod] = useState<"qr" | "phone">("qr");

  // QR Flow states
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrPasswordRequired, setQrPasswordRequired] = useState(false);
  const [qrConnected, setQrConnected] = useState(false);
  const [qrError, setQrError] = useState("");
  const [qrLoading, setQrLoading] = useState(false);
  const [qrPassword, setQrPassword] = useState("");
  const [qrSubmitLoading, setQrSubmitLoading] = useState(false);

  // Phone Flow states
  const [phoneStep, setPhoneStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [phonePassword, setPhonePassword] = useState("");
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneError, setPhoneError] = useState("");

  const goToAuth = () => {
    if (!apiId || !apiHash) { setPhoneError("Both fields required"); return; }
    setPhoneError(""); setStep("auth");
  };

  // QR polling hook
  useEffect(() => {
    if (loginMethod !== "qr" || step === "credentials") return;

    let active = true;
    let timeoutId: NodeJS.Timeout;

    const startQrFlow = async () => {
      setQrLoading(true);
      setQrError("");
      try {
        await telegramPersonalApi.startQr({
          ...(hasEnvCreds ? {} : { apiId: Number(apiId), apiHash }),
        });
        
        const poll = async () => {
          if (!active) return;
          try {
            const status = await telegramPersonalApi.getQrStatus();
            if (status.connected) {
              setQrConnected(true);
              setQrCode(null);
              setQrPasswordRequired(false);
              setTimeout(() => {
                onClose();
              }, 1500);
              return;
            }
            if (status.qr) {
              setQrCode(status.qr);
            }
            if (status.passwordRequired) {
              setQrPasswordRequired(true);
            }
            if (status.error) {
              setQrError(status.error);
            }
          } catch (e: any) {
            console.error("Error polling Telegram QR status", e);
          }
          if (active && !qrConnected) {
            timeoutId = setTimeout(poll, 2000);
          }
        };

        poll();
      } catch (err: any) {
        setQrError(err.message || "Failed to start QR session");
      } finally {
        setQrLoading(false);
      }
    };

    startQrFlow();

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginMethod, step]);

  const submitQrPassword = async () => {
    if (!qrPassword) return;
    setQrSubmitLoading(true);
    setQrError("");
    try {
      await telegramPersonalApi.submitPassword(qrPassword);
      setQrPasswordRequired(false);
    } catch (e: any) {
      setQrError(e.message || "Failed to submit password");
    } finally {
      setQrSubmitLoading(false);
    }
  };

  // Phone code sending
  const sendPhoneCode = async () => {
    if (!phone) { setPhoneError("Phone number required"); return; }
    setPhoneLoading(true); setPhoneError("");
    try {
      await telegramPersonalApi.sendCode({
        phoneNumber: phone,
        ...(hasEnvCreds ? {} : { apiId: Number(apiId), apiHash }),
      });
      setPhoneStep("code");
    } catch (e: unknown) {
      setPhoneError(e instanceof Error ? e.message : "Failed to send code");
    } finally {
      setPhoneLoading(false);
    }
  };

  // Phone verification
  const verifyPhone = async () => {
    if (!code) { setPhoneError("Code required"); return; }
    setPhoneLoading(true); setPhoneError("");
    try {
      await telegramPersonalApi.verify({ code, password: phonePassword || undefined });
      telegramPersonalApi.sync().catch(() => {});
      onClose();
    } catch (e: unknown) {
      setPhoneError(e instanceof Error ? e.message : "Failed to verify code");
    } finally {
      setPhoneLoading(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[400px] rounded-2xl p-6">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold text-foreground">Connect Telegram (Personal)</DialogTitle>
        </DialogHeader>

        {step === "credentials" && (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              One-time setup: log in to <strong>my.telegram.org/apps</strong>, create an application, and copy your API details below:
            </p>
            <div className="space-y-3">
              <input value={apiId} onChange={(e) => setApiId(e.target.value)}
                placeholder="API ID (e.g. 12345678)"
                className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60" />
              <input value={apiHash} onChange={(e) => setApiHash(e.target.value)}
                placeholder="API Hash (32-char hex)"
                className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60" />
            </div>
            {phoneError && <p className="text-status-red text-xs mt-1 bg-status-red/10 px-3 py-1.5 rounded-lg font-medium">{phoneError}</p>}
            <div className="flex gap-2.5 justify-end mt-3">
              <Button size="sm" variant="outline" className="rounded-xl px-4" onClick={onClose}>Cancel</Button>
              <Button size="sm" className="rounded-xl px-4" onClick={goToAuth} disabled={!apiId || !apiHash}>Next →</Button>
            </div>
          </div>
        )}

        {step === "auth" && (
          <div className="flex flex-col gap-1 py-1">
            {/* Tabs */}
            <div className="flex p-1 bg-muted/60 rounded-xl mb-4 border border-border/40">
              <button
                className={`flex-1 text-xs py-1.5 font-semibold rounded-lg transition-all ${
                  loginMethod === "qr"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => { setLoginMethod("qr"); setPhoneError(""); }}
              >
                Scan QR Code
              </button>
              <button
                className={`flex-1 text-xs py-1.5 font-semibold rounded-lg transition-all ${
                  loginMethod === "phone"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => { setLoginMethod("phone"); setQrError(""); }}
              >
                Use Phone Number
              </button>
            </div>

            {/* QR Login view */}
            {loginMethod === "qr" && (
              <div className="flex flex-col items-center justify-center py-2 text-center">
                {qrLoading && !qrCode && (
                  <div className="py-8 flex flex-col items-center justify-center gap-3">
                    <div className="w-8 h-8 border-3 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <p className="text-xs text-muted-foreground font-medium">Generating secure login QR…</p>
                  </div>
                )}
                {qrError && (
                  <p className="text-status-red text-xs w-full bg-status-red/10 px-3 py-2.5 rounded-xl font-medium text-left leading-normal border border-status-red/20 mb-3">
                    {qrError}
                  </p>
                )}
                {qrConnected && (
                  <div className="py-6 flex flex-col items-center gap-3 animate-in fade-in zoom-in-95 duration-300">
                    <div className="w-12 h-12 bg-status-green/10 text-status-green rounded-full flex items-center justify-center text-2xl font-bold">
                      ✓
                    </div>
                    <div>
                      <p className="font-bold text-status-green text-sm">Telegram connected successfully!</p>
                      <p className="text-xs text-muted-foreground mt-1">Closing and loading messages…</p>
                    </div>
                  </div>
                )}
                {qrCode && !qrConnected && !qrPasswordRequired && (
                  <div className="flex flex-col items-center gap-4 w-full animate-in fade-in duration-300">
                    <p className="text-xs text-muted-foreground leading-normal text-left w-full">
                      Open Telegram on your phone → <strong>Settings</strong> → <strong>Devices</strong> → <strong>Link Desktop Device</strong> → scan this code.
                    </p>
                    <div className="p-3 bg-white rounded-2xl border border-border/80 shadow-md">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={qrCode} alt="Telegram QR code" className="w-[180px] h-[180px] rounded-lg" />
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      <span className="text-[11px] font-semibold text-muted-foreground">Waiting for device scanning…</span>
                    </div>
                  </div>
                )}
                {qrPasswordRequired && !qrConnected && (
                  <div className="flex flex-col gap-3 w-full text-left animate-in slide-in-from-bottom-2 duration-300">
                    <p className="text-xs text-muted-foreground leading-normal">
                      Your Telegram account has <strong>Two-Step Verification</strong> enabled. Please enter your account password:
                    </p>
                    <input
                      type="password"
                      value={qrPassword}
                      onChange={(e) => setQrPassword(e.target.value)}
                      placeholder="Two-Step password"
                      className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
                    />
                    <div className="flex justify-end gap-2.5 mt-2">
                      <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setLoginMethod("phone")}>Cancel</Button>
                      <Button size="sm" className="rounded-xl px-4" onClick={submitQrPassword} disabled={qrSubmitLoading || !qrPassword}>
                        {qrSubmitLoading ? "Verifying…" : "Submit Password"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Phone Login view */}
            {loginMethod === "phone" && (
              <div className="flex flex-col gap-3 w-full py-1">
                {phoneStep === "phone" && (
                  <div className="flex flex-col gap-3 animate-in fade-in duration-200">
                    <p className="text-xs text-muted-foreground">Enter your Telegram phone number (international format) to receive a verification code:</p>
                    <input value={phone} onChange={(e) => setPhone(e.target.value)}
                      placeholder="Phone number (e.g. +918194047426)"
                      className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60" />
                    {phoneError && <p className="text-status-red text-xs mt-0.5 bg-status-red/10 px-3 py-1.5 rounded-lg font-medium leading-normal">{phoneError}</p>}
                    <div className="flex gap-2.5 justify-end mt-2">
                      {!hasEnvCreds && <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setStep("credentials")}>Back</Button>}
                      {hasEnvCreds && <Button size="sm" variant="outline" className="rounded-xl" onClick={onClose}>Cancel</Button>}
                      <Button size="sm" className="rounded-xl px-4" onClick={sendPhoneCode} disabled={phoneLoading || !phone}>
                        {phoneLoading ? "Sending…" : "Send code"}
                      </Button>
                    </div>
                  </div>
                )}

                {phoneStep === "code" && (
                  <div className="flex flex-col gap-3 animate-in slide-in-from-right-3 duration-250">
                    <p className="text-xs text-muted-foreground leading-normal">Enter the verification code Telegram sent to <strong>{phone}</strong>.</p>
                    <input value={code} onChange={(e) => setCode(e.target.value)}
                      placeholder="Verification code"
                      className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60" />
                    <input value={phonePassword} onChange={(e) => setPhonePassword(e.target.value)}
                      placeholder="2FA password (if enabled)" type="password"
                      className="w-full px-3.5 py-2 text-sm rounded-xl border border-border bg-muted/30 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-muted-foreground/60" />
                    {phoneError && <p className="text-status-red text-xs mt-0.5 bg-status-red/10 px-3 py-1.5 rounded-lg font-medium leading-normal">{phoneError}</p>}
                    <div className="flex gap-2.5 justify-end mt-2">
                      <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setPhoneStep("phone")}>Back</Button>
                      <Button size="sm" className="rounded-xl px-4" onClick={verifyPhone} disabled={phoneLoading || !code}>
                        {phoneLoading ? "Verifying…" : "Verify"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LinkedInCookieModal({ onSave, onClose }: { onSave: (cookie: string) => Promise<void>; onClose: () => void }) {
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!cookie.trim()) return;
    setLoading(true); setError("");
    try { await onSave(cookie.trim()); onClose(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : "Failed to save cookie"); }
    finally { setLoading(false); }
  };
  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Connect LinkedIn Messages</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <p className="text-xs text-muted-foreground leading-normal">
            LinkedIn doesn&apos;t offer a messaging API, so we use your browser session cookie (the same way Beeper works).<br /><br />
            <strong>How to get your li_at cookie:</strong><br />
            1. Open <strong>linkedin.com</strong> and log in<br />
            2. Open DevTools → <strong>Application → Cookies → linkedin.com</strong><br />
            3. Find the cookie named <strong>li_at</strong> and copy its value<br />
            4. Paste it below
          </p>
          <input
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="AQEDATeB... (li_at cookie value)"
            className="w-full px-3 py-1.5 text-sm rounded-lg border border-border bg-muted/50 text-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
          <p className="text-[10px] text-muted-foreground">Your cookie is stored securely and only used to fetch your LinkedIn DMs on your behalf.</p>
        </div>
        <div className="flex gap-2 justify-end mt-2">
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={loading || !cookie.trim()}>{loading && <Spinner />}{loading ? "Connecting…" : "Connect"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WhatsAppModal({ onClose }: { onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    whatsappApi.init()
      .then((res) => {
        if (res.connected) { setConnected(true); }
        else if (res.qr) { setQr(res.qr); }
        else { setError("No QR code returned. Try again."); }
      })
      .catch((e) => setError(e.message ?? "Failed to start WhatsApp session"))
      .finally(() => setLoading(false));
  }, []);

  // Poll for connection after QR shown
  useEffect(() => {
    if (!qr || connected) return;
    const iv = setInterval(async () => {
      const s = await whatsappApi.status().catch(() => null);
      if (s?.connected) { setConnected(true); setQr(null); clearInterval(iv); }
    }, 3000);
    return () => clearInterval(iv);
  }, [qr, connected]);

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Connect WhatsApp</DialogTitle>
        </DialogHeader>
        {loading && <p className="text-center text-muted-foreground text-xs py-4">Starting session…</p>}
        {error && <p className="text-status-red text-xs py-2">{error}</p>}
        {connected && (
          <div className="text-center py-4 flex flex-col items-center gap-2">
            <div className="text-3xl mb-1">✅</div>
            <p className="font-semibold text-status-green">WhatsApp connected!</p>
            <p className="text-xs text-muted-foreground">Messages will appear in your inbox automatically.</p>
            <Button size="sm" className="mt-4" onClick={onClose}>Done</Button>
          </div>
        )}
        {qr && !connected && (
          <div className="flex flex-col gap-3 py-2 items-center">
            <p className="text-xs text-muted-foreground leading-normal text-left w-full">
              Open WhatsApp on your phone → <strong>Linked Devices</strong> → <strong>Link a device</strong> → scan this QR code.
            </p>
            <div className="relative p-2 bg-white rounded-xl border border-border">
              <img src={qr} alt="WhatsApp QR code" className="w-[180px] h-[180px] rounded-lg" />
            </div>
            <p className="text-[11px] text-muted-foreground animate-pulse mt-1">Waiting for scan…</p>
            <p className="text-[10px] text-muted-foreground text-center leading-normal border-t border-border pt-2 w-full">
              ⚠️ Unofficial API — use a secondary phone number if you want to be safe.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Persist statuses in localStorage to avoid flicker on re-visit ───────────

const CACHE_KEY = "suby_integration_status_v1";

type CachedStatuses = {
  gcal?: { connected: boolean; lastSync: string | null };
  gmail?: { connected: boolean; lastSync: string | null };
  discord?: { connected: boolean; lastSync: string | null; username?: string };
  slack?: { connected: boolean; lastSync: string | null; teamName?: string };
  xStatus?: { connected: boolean; lastSync: string | null; screenName?: string; hasEnvCreds?: boolean };
  whatsapp?: { connected: boolean; phoneNumber: string | null };
  tgPersonal?: { connected: boolean; lastSync: string | null; phone?: string; hasEnvCreds?: boolean };
  linkedin?: { connected: boolean; profileName: string | null };
};

function readCache(): CachedStatuses {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}"); } catch { return {}; }
}

function writeCache(s: CachedStatuses) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(s)); } catch {}
}

// ─── Main settings view ───────────────────────────────────────────────────────

export function SettingsView() {
  const [pending, setPending] = useState<string | null>(null);
  const [modal, setModal] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  // All null on SSR — populated from localStorage on first client effect (before reload)
  const [gcal, setGcal] = useState<{ connected: boolean; lastSync: string | null } | null>(null);
  const [gmail, setGmail] = useState<{ connected: boolean; lastSync: string | null } | null>(null);
  const [discord, setDiscord] = useState<{ connected: boolean; lastSync: string | null; username?: string } | null>(null);
  const [slack, setSlack] = useState<{ connected: boolean; lastSync: string | null; teamName?: string } | null>(null);
  const [xStatus, setXStatus] = useState<{ connected: boolean; lastSync: string | null; screenName?: string; hasEnvCreds?: boolean } | null>(null);
  const [whatsapp, setWhatsapp] = useState<{ connected: boolean; phoneNumber: string | null } | null>(null);
  const [tgPersonal, setTgPersonal] = useState<{ connected: boolean; lastSync: string | null; phone?: string; hasEnvCreds?: boolean } | null>(null);
  const [linkedin, setLinkedin] = useState<{ connected: boolean; profileName: string | null } | null>(null);

  const reload = () => {
    calendarApi.status()
      .then((v) => { setGcal(v); writeCache({ ...readCache(), gcal: v }); })
      .catch(() => setGcal((p) => p ?? { connected: false, lastSync: null }));
    gmailApi.status()
      .then((v) => { setGmail(v); writeCache({ ...readCache(), gmail: v }); })
      .catch(() => setGmail((p) => p ?? { connected: false, lastSync: null }));
    discordApi.status()
      .then((v) => { setDiscord(v); writeCache({ ...readCache(), discord: v }); })
      .catch(() => setDiscord((p) => p ?? { connected: false, lastSync: null }));
    slackApi.status()
      .then((v) => { setSlack(v); writeCache({ ...readCache(), slack: v }); })
      .catch(() => setSlack((p) => p ?? { connected: false, lastSync: null }));
    xApi.status()
      .then((v) => { setXStatus(v); writeCache({ ...readCache(), xStatus: v }); })
      .catch(() => setXStatus((p) => p ?? { connected: false, lastSync: null }));
    whatsappApi.status()
      .then((s) => { const v = { connected: s.connected, phoneNumber: s.phoneNumber }; setWhatsapp(v); writeCache({ ...readCache(), whatsapp: v }); })
      .catch(() => setWhatsapp((p) => p ?? { connected: false, phoneNumber: null }));
    telegramPersonalApi.status()
      .then((v) => { setTgPersonal(v); writeCache({ ...readCache(), tgPersonal: v }); })
      .catch(() => setTgPersonal((p) => p ?? { connected: false, lastSync: null }));
    linkedinApi.status()
      .then((v) => { setLinkedin(v); writeCache({ ...readCache(), linkedin: v }); })
      .catch(() => setLinkedin((p) => p ?? { connected: false, profileName: null }));
  };

  useEffect(() => {
    // Restore from cache first — instant, no flicker
    const c = readCache();
    if (c.gcal) setGcal(c.gcal);
    if (c.gmail) setGmail(c.gmail);
    if (c.discord) setDiscord(c.discord);
    if (c.slack) setSlack(c.slack);
    if (c.xStatus) setXStatus(c.xStatus);
    if (c.whatsapp) setWhatsapp(c.whatsapp);
    if (c.tgPersonal) setTgPersonal(c.tgPersonal);
    if (c.linkedin) setLinkedin(c.linkedin);
    // Then fetch real state in background
    reload();
    const params = new URLSearchParams(window.location.search);
    if (params.get("slack") || params.get("calendar") || params.get("gmail") || params.get("x") || params.get("linkedin") || params.get("discord")) {
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(reload, 2000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusFor = (key: string): Status => {
    if (key === "google_calendar") return gcal?.connected ? "connected" : "disconnected";
    if (key === "gmail") return gmail?.connected ? "connected" : "disconnected";
    if (key === "discord") return discord?.connected ? "connected" : "disconnected";
    if (key === "slack") return slack?.connected ? "connected" : "disconnected";
    if (key === "x") return xStatus?.connected ? "connected" : "disconnected";
    if (key === "whatsapp") return whatsapp?.connected ? "connected" : "disconnected";
    if (key === "telegram_personal") return tgPersonal?.connected ? "connected" : "disconnected";
    if (key === "linkedin") return linkedin?.connected ? "connected" : "disconnected";
    if (key === "subyassist_bot") return "connected"; // always on (bot is running)
    return "disconnected";
  };

  const metaFor = (key: string): string | undefined => {
    if (key === "google_calendar") return gcal?.lastSync ? `Last synced ${new Date(gcal.lastSync).toLocaleString()}` : gcal?.connected ? "Just connected" : undefined;
    if (key === "gmail") return gmail?.lastSync ? `Last synced ${new Date(gmail.lastSync).toLocaleString()}` : gmail?.connected ? "Just connected" : undefined;
    if (key === "discord") return discord?.username ? `Bot: ${discord.username}` : undefined;
    if (key === "slack") return slack?.teamName ? `Team: ${slack.teamName}` : undefined;
    if (key === "x") return xStatus?.screenName ? `@${xStatus.screenName}` : undefined;
    if (key === "whatsapp") return whatsapp?.phoneNumber ? `+${whatsapp.phoneNumber}` : undefined;
    if (key === "telegram_personal") return tgPersonal?.phone ? tgPersonal.phone : undefined;
    if (key === "linkedin") return linkedin?.profileName ? linkedin.profileName : undefined;
    if (key === "subyassist_bot") return "@subyassistant_bot · active";
    return undefined;
  };

  const syncTelegram = async (deep = false) => {
    setSyncing("telegram_personal");
    try {
      if (deep) await telegramPersonalApi.syncHistory();
      else await telegramPersonalApi.sync();
      reload();
    } catch (e: any) {
      alert(`Sync failed: ${e.message || "Unknown error"}`);
    } finally {
      setSyncing(null);
    }
  };

  const toggle = async (key: string) => {
    const s = statusFor(key);

    if (s === "connected") {
      // Disconnect
      setPending(key);
      try {
        if (key === "google_calendar") { await calendarApi.disconnect(); setGcal({ connected: false, lastSync: null }); }
        else if (key === "gmail") { await gmailApi.disconnect(); setGmail({ connected: false, lastSync: null }); }
        else if (key === "discord") { await discordApi.disconnect(); setDiscord({ connected: false, lastSync: null }); }
        else if (key === "slack") { await slackApi.disconnect(); setSlack({ connected: false, lastSync: null }); }
        else if (key === "x") { await xApi.disconnect(); setXStatus({ connected: false, lastSync: null }); }
        else if (key === "whatsapp") { await whatsappApi.disconnect(); setWhatsapp({ connected: false, phoneNumber: null }); }
        else if (key === "telegram_personal") { await telegramPersonalApi.disconnect(); setTgPersonal({ connected: false, lastSync: null }); }
        else if (key === "linkedin") { await linkedinApi.disconnect(); setLinkedin({ connected: false, profileName: null }); }
      } catch { /* ignore */ }
      finally { setPending(null); }
      return;
    }

    // Connect — open modal or redirect
    if (key === "google_calendar") {
      setPending(key);
      try { const { url } = await calendarApi.connectUrl(); window.location.href = url; }
      catch { setPending(null); }
    } else if (key === "gmail") {
      setPending(key);
      try { const { url } = await gmailApi.connectUrl(); window.location.href = url; }
      catch { setPending(null); }
    } else if (key === "slack") {
      setPending(key);
      try { const { url } = await slackApi.connectUrl(); window.location.href = url; }
      catch { setPending(null); }
    } else if (key === "x") {
      setPending(key);
      try { const { url } = await xApi.connectUrl(); window.location.href = url; }
      catch (e: any) {
        setPending(null);
        alert(`Failed to start Twitter login: ${e.message || "Unknown error"}.\n\nTo fix this, please ensure:\n1. X_CONSUMER_KEY and X_CONSUMER_SECRET are correct in your .env.local.\n2. In your Twitter Developer App settings, "User authentication settings" is enabled, OAuth 1.0a is turned on, and Callback URL is set to "http://localhost:4002/api/x/callback".`);
      }
    } else if (key === "linkedin") {
      setPending(key);
      try { const { url } = await linkedinApi.connectUrl(); window.location.href = url; }
      catch { setPending(null); }
    } else if (key === "discord") {
      setPending(key);
      try { const { url } = await discordApi.connectUrl(); window.location.href = url; }
      catch { setPending(null); setModal(key); }
    } else {
      // Open modal for WhatsApp, Telegram personal
      setModal(key);
    }
  };

  const connectedCount = ["google_calendar", "gmail", "discord", "slack", "x", "linkedin", "whatsapp", "telegram_personal", "subyassist_bot"]
    .filter((k) => statusFor(k) === "connected").length;

  const def = Object.fromEntries(INTEGRATIONS.map((i) => [i.key, i]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 920 }}>
      <div>
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p style={{ color: "var(--t2)", fontSize: 13, marginTop: 4 }}>{connectedCount} integrations connected</p>
      </div>

      {GROUPS.map((group) => (
        <section key={group.label}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground" style={{ marginBottom: 12 }}>{group.label}</div>
          <div className="rounded-xl border border-border bg-card shadow-sm" style={{ overflow: "hidden" }}>
            {group.keys.map((k, idx) => {
              const i = def[k];
              if (!i) return null;
              const effectiveStatus = statusFor(k);
              const s = STATUS_META[effectiveStatus];
              const meta = metaFor(k);
              const isLast = idx === group.keys.length - 1;
              const isPending = pending === k;
              const isConnected = effectiveStatus === "connected";
              const isBotOnly = k === "subyassist_bot";

              return (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: isLast ? "none" : "1px solid var(--bd)" }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: i.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill={i.color} aria-hidden>
                      <path d={i.iconPath} />
                    </svg>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--t1)" }}>{i.name}</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 999, background: s.bg, color: s.color, fontSize: 10, fontWeight: 600 }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.dot }} />
                        {s.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 2, lineHeight: 1.4 }}>{i.description}</div>
                    {meta && (
                      <span className="font-mono text-xs tabular-nums" style={{ fontSize: 11, marginTop: 4, display: "inline-block", padding: "1px 7px", background: "var(--al)", borderRadius: 4, color: "var(--t2)" }}>
                        {meta}
                      </span>
                    )}
                  </div>

                  {!isBotOnly && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {k === "telegram_personal" && isConnected && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => syncTelegram(false)} disabled={syncing === "telegram_personal"} className="min-w-[70px]">
                            {syncing === "telegram_personal" && <Spinner />}{syncing === "telegram_personal" ? "Syncing…" : "Sync"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => syncTelegram(true)} disabled={syncing === "telegram_personal"} title="Import full message history (slower)" className="min-w-[110px] text-xs">
                            Sync Full History
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant={isConnected ? "outline" : "default"} onClick={() => toggle(k)} disabled={isPending} className="min-w-[100px]">
                        {isPending && <Spinner />}{isPending ? (isConnected ? "Disconnecting…" : "Connecting…") : isConnected ? "Disconnect" : "Connect"}
                      </Button>
                    </div>
                  )}
                  {isBotOnly && isConnected && (
                    <span style={{ fontSize: 11, color: "var(--gc)", padding: "4px 10px", background: "var(--gb)", borderRadius: 6, whiteSpace: "nowrap" }}>Active</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Data import */}
      <section>
        <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground" style={{ marginBottom: 12 }}>Data import</div>
        <Link href="/dashboard/import" className="rounded-xl border border-border bg-card shadow-sm block hover:shadow transition-shadow"
          style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", textDecoration: "none", color: "inherit" }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--bb)", color: "var(--bc)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--t1)" }}>Import &amp; sync history</div>
            <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 2 }}>View Beeper / Telegram / WhatsApp import jobs and trigger a new sync.</div>
          </div>
          <span style={{ fontSize: 13, color: "var(--t3)" }}>→</span>
        </Link>
      </section>

      <p style={{ fontSize: 11, color: "var(--t3)", textAlign: "center" }}>Need another integration? Drop a note in <span className="font-mono text-xs tabular-nums">#suby-feedback</span>.</p>

      {/* Modals */}
      {modal === "discord" && (
        <DiscordModal
          onConnect={async (token) => { await discordApi.connect(token); reload(); }}
          onClose={() => { setModal(null); reload(); }}
        />
      )}
      {modal === "x" && (
        <XModal
          hasEnvCreds={xStatus?.hasEnvCreds}
          onConnect={async (d) => { await xApi.connect(d); reload(); }}
          onClose={() => { setModal(null); reload(); }}
        />
      )}
      {modal === "telegram_personal" && (
        <TelegramPersonalModal hasEnvCreds={tgPersonal?.hasEnvCreds} onClose={() => { setModal(null); reload(); }} />
      )}
      {modal === "whatsapp" && (
        <WhatsAppModal onClose={() => { setModal(null); reload(); }} />
      )}
    </div>
  );
}
