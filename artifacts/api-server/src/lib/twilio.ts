import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";

/**
 * Twilio delivery with two paths:
 *
 *  1. Direct REST using TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN. Works anywhere —
 *     local machine, VPS, container — and is the only path that can reach a phone
 *     outside Replit.
 *  2. The Replit connector proxy, which only resolves inside a Replit runtime.
 *
 * Direct credentials win when both are present.
 */

const TWILIO_API_ROOT = "https://api.twilio.com";
const connectors = new ReplitConnectors();

type TwilioAccountResponse = { accounts?: Array<{ sid?: string }> };

export type DeliveryMode = "direct" | "replit-connector" | "disabled";

const fromNumber = () => process.env.TWILIO_FROM_NUMBER?.trim() || null;
const directSid = () => process.env.TWILIO_ACCOUNT_SID?.trim() || null;
const directToken = () => process.env.TWILIO_AUTH_TOKEN?.trim() || null;

export function deliveryMode(): DeliveryMode {
  if (!fromNumber()) return "disabled";
  if (directSid() && directToken()) return "direct";
  if (process.env.REPL_ID) return "replit-connector";
  return "disabled";
}

/** Human-readable reason, surfaced by /api/healthz so misconfiguration is visible. */
export function outboundMessagingStatus(): string {
  if (!fromNumber()) return "disabled: TWILIO_FROM_NUMBER is not set";
  switch (deliveryMode()) {
    case "direct":
      return `direct Twilio REST as ${fromNumber()}`;
    case "replit-connector":
      return `Replit Twilio connector as ${fromNumber()}`;
    default:
      return "disabled: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, or run inside Replit with the Twilio connector";
  }
}

export function outboundMessagingConfigured(): boolean {
  return deliveryMode() !== "disabled";
}

async function postDirect(resource: string, values: Record<string, string>): Promise<boolean> {
  const sid = directSid();
  const token = directToken();
  if (!sid || !token) return false;

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  try {
    const response = await fetch(`${TWILIO_API_ROOT}/2010-04-01/Accounts/${sid}/${resource}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(values).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Twilio explains refusals in the body (unverified number, bad from, no funds).
      const detail = await response.text().catch(() => "");
      logger.warn({ resource, status: response.status, detail: detail.slice(0, 400) }, "Twilio rejected an outbound request");
      return false;
    }
    return true;
  } catch (err: unknown) {
    logger.warn({ err, resource }, "Twilio request failed");
    return false;
  }
}

async function proxy(path: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
  try {
    return await connectors.proxy("twilio", path, init);
  } catch (err: unknown) {
    logger.warn({ err, path }, "Twilio connector is unavailable");
    return null;
  }
}

async function connectorAccountSid(): Promise<string | null> {
  const response = await proxy("/2010-04-01/Accounts.json", { method: "GET" });
  if (!response?.ok) return null;
  try {
    const payload = (await response.json()) as TwilioAccountResponse;
    return payload.accounts?.[0]?.sid ?? null;
  } catch (err: unknown) {
    logger.warn({ err }, "Could not read the Twilio account list");
    return null;
  }
}

async function postViaConnector(resource: string, values: Record<string, string>): Promise<boolean> {
  const sid = await connectorAccountSid();
  if (!sid) return false;
  const response = await proxy(`/2010-04-01/Accounts/${sid}/${resource}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
  if (!response) return false;
  if (!response.ok) {
    logger.warn({ resource, status: response.status }, "Twilio rejected an outbound request");
    return false;
  }
  return true;
}

async function post(resource: string, values: Record<string, string>): Promise<boolean> {
  switch (deliveryMode()) {
    case "direct":
      return postDirect(resource, values);
    case "replit-connector":
      return postViaConnector(resource, values);
    default:
      return false;
  }
}

export async function sendSms(to: string, body: string): Promise<boolean> {
  const from = fromNumber();
  if (!from) return false;
  return post("Messages.json", { From: from, To: to, Body: body });
}

export async function placeCall(to: string, body: string): Promise<boolean> {
  const from = fromNumber();
  if (!from) return false;
  // Escape for XML rather than dropping characters, so the spoken text stays intact.
  const spoken = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const twiml = `<Response><Say>${spoken}</Say><Pause length="1"/><Say>${spoken}</Say></Response>`;
  return post("Calls.json", { From: from, To: to, Twiml: twiml });
}

/** Used by the self-test endpoint so delivery can be verified without waiting for a miss. */
export async function sendTest(to: string, channel: "sms" | "call"): Promise<boolean> {
  const message = "Accountability Chat test message. Delivery is working.";
  return channel === "call" ? placeCall(to, message) : sendSms(to, message);
}
