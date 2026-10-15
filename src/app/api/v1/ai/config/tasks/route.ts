import { authed } from "@/server/api/handler";
import { taskConfigSchema, updateTaskConfigs } from "@/server/ai/api";

export const PUT = authed({ body: taskConfigSchema, permission: "integrations:manage" }, async ({ ctx, body }) => updateTaskConfigs(ctx, body));
