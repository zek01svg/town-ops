import type { CaseItem } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function mapApiCaseToItem(raw: unknown): CaseItem {
  const data = isRecord(raw) ? raw : {};
  return {
    id: data.id as string,
    residentId: (data.resident_id ?? data.residentId) as string,
    address: (data.address_details ?? data.addressDetails ?? "") as string,
    category: data.category as string,
    priority: data.priority as CaseItem["priority"],
    status: data.status as CaseItem["status"],
    description: (data.description ?? undefined) as string | undefined,
    createdAt: (data.created_at ?? data.createdAt) as string,
    updatedAt: (data.updated_at ?? data.updatedAt) as string,
  };
}
