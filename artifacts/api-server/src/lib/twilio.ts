import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

type TwilioAccountResponse = {
  accounts?: Array<{ sid?: string }>;
};

async function getAccountSid(): Promise<string | null> {
  const response = await connectors.proxy("twilio", "/2010-04-01/Accounts.json", { method: "GET" });
  if (!response.ok) return null;
  const payload = (await response.json()) as TwilioAccountResponse;
  return payload.accounts?.[0]?.sid ?? null;
}

async function postTwilioForm(path: string, values: Record<string, string>) {
  const response = await connectors.proxy("twilio", path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
  return response.ok;
}

export function outboundMessagingConfigured() {
  return Boolean(process.env.TWILIO_FROM_NUMBER);
}

export async function sendSms(to: string, body: string): Promise<boolean> {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) return false;
  const accountSid = await getAccountSid();
  if (!accountSid) return false;
  return postTwilioForm(`/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    From: from,
    To: to,
    Body: body,
  });
}

export async function placeCall(to: string, body: string): Promise<boolean> {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) return false;
  const accountSid = await getAccountSid();
  if (!accountSid) return false;
  const twiml = `<Response><Say>${body.replace(/[<&>]/g, "")}</Say></Response>`;
  return postTwilioForm(`/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    From: from,
    To: to,
    Twiml: twiml,
  });
}