import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string(),
  time: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

// OIDs identify studies, metadata versions, forms, items, etc. throughout ODM.
// ODM v2.0 `oid` type: at least one character, no leading/trailing whitespace.
export const oidSchema = z
  .string()
  .min(1)
  .regex(/^\S(.*\S)?$/, "OIDs must not have leading or trailing whitespace");

export type Oid = z.infer<typeof oidSchema>;

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const createStudyRequestSchema = z.object({
  oid: oidSchema,
  name: z.string().min(1),
  protocolName: z.string().min(1).optional(),
});

export type CreateStudyRequest = z.infer<typeof createStudyRequestSchema>;

export const grantRoleRequestSchema = z.object({
  userId: z.uuid(),
  roleName: z.string().min(1),
  siteId: z.uuid().optional(),
});

export type GrantRoleRequest = z.infer<typeof grantRoleRequestSchema>;
