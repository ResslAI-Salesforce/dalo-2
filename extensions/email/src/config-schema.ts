import { DmPolicySchema, requireOpenAllowFrom } from "openclaw/plugin-sdk";
import { z } from "zod";

const EmailAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    gmailAddress: z.string().optional(),
    credentialsPath: z.string().optional(),
    tokenPath: z.string().optional(),
    projectId: z.string().optional(),
    pubsubTopic: z.string().optional(),
    pubsubSubscription: z.string().optional(),
    pushToken: z.string().optional(),
    watchLabel: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("allowlist"),
    allowFrom: z.array(z.string()).optional(),
    preserveCc: z.boolean().optional(),
    signature: z.string().optional(),
    servePort: z.number().int().positive().optional(),
    serveBind: z.string().optional(),
    renewEveryMinutes: z.number().int().positive().optional(),
    hookUrl: z.string().optional(),
    hookToken: z.string().optional(),
    pollIntervalSeconds: z.number().int().positive().optional(),
  })
  .strict();

const EmailAccountSchema = EmailAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.email.dmPolicy="open" requires channels.email.allowFrom to include "*"',
  });
});

export const EmailConfigSchema = EmailAccountSchemaBase.extend({
  accounts: z.record(z.string(), EmailAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.email.dmPolicy="open" requires channels.email.allowFrom to include "*"',
  });
});
