import type { MemberRole } from "@prisma/client";
import { ForbiddenError } from "../errors";

export type Permission =
  | "transactions:read"
  | "transactions:write"
  | "transactions:delete"
  | "accounts:write"
  | "cards:write"
  | "categories:write"
  | "budgets:write"
  | "goals:write"
  | "bills:write"
  | "rules:write"
  | "reports:read"
  | "data:import"
  | "data:export"
  | "integrations:manage"
  | "settings:manage"
  | "members:manage"
  | "audit:read"
  | "household:delete";

const READ: Permission[] = ["transactions:read", "reports:read"];
const WRITE: Permission[] = [
  ...READ,
  "transactions:write",
  "transactions:delete",
  "accounts:write",
  "cards:write",
  "categories:write",
  "budgets:write",
  "goals:write",
  "bills:write",
  "rules:write",
  "data:import",
  "data:export",
];
const ADMIN: Permission[] = [...WRITE, "integrations:manage", "settings:manage", "members:manage", "audit:read"];

const MATRIX: Record<MemberRole, ReadonlySet<Permission>> = {
  VIEWER: new Set(READ),
  MEMBER: new Set(WRITE),
  ADMIN: new Set(ADMIN),
  OWNER: new Set<Permission>([...ADMIN, "household:delete"]),
};

export function can(role: MemberRole, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function assertCan(ctx: { role: MemberRole }, permission: Permission): void {
  if (!can(ctx.role, permission)) throw new ForbiddenError();
}

export function permissionsFor(role: MemberRole): Permission[] {
  return [...MATRIX[role]];
}
