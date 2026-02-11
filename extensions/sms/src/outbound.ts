/**
 * Outbound SMS management via Twilio REST API.
 *
 * Sends text messages by POSTing to Twilio's Messages endpoint.
 * Uses Basic Auth (account_sid:auth_token) and form-urlencoded body.
 */

import type { SmsPluginConfig, SmsOutboundResult } from "./types.js";

export class OutboundManager {
  private config: SmsPluginConfig;
  private logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  constructor(
    config: SmsPluginConfig,
    logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  ) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Send an SMS via Twilio's REST API.
   *
   * POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
   * Auth: Basic base64(account_sid:auth_token)
   * Body: From, To, Body (form-urlencoded)
   */
  async sendSms(to: string, text: string): Promise<SmsOutboundResult> {
    const { account_sid, auth_token, phone_number } = this.config;

    if (!account_sid || !auth_token || !phone_number) {
      return {
        success: false,
        error: "account_sid, auth_token, and phone_number required for outbound SMS",
      };
    }

    const cleanNumber = to.replace(/[^+0-9]/g, "");

    const params = new URLSearchParams();
    params.set("From", phone_number);
    params.set("To", cleanNumber);
    params.set("Body", text);

    const credentials = Buffer.from(`${account_sid}:${auth_token}`).toString("base64");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages.json`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Twilio API ${response.status}: ${errorText}` };
      }

      const data = (await response.json()) as { sid: string };
      this.logger.info(`[sms] Message sent: ${data.sid} → ${cleanNumber}`);
      return { success: true, sid: data.sid };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[sms] Send failed: ${msg}`);
      return { success: false, error: msg };
    }
  }
}
