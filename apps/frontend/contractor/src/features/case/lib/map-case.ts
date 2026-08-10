import type { CaseItem } from "../types";

export function mapApiCaseToItem(raw: Record<string, unknown>): CaseItem {
  return {
    id: raw.id as string,
    residentId: (raw.resident_id ?? raw.residentId ?? "") as string,
    address: (raw.address_details ?? raw.addressDetails ?? "") as string,
    category: (raw.category ?? "") as string,
    priority: raw.priority as CaseItem["priority"],
    status: raw.status as CaseItem["status"],
    description: (raw.description ?? "") as string,
    createdAt: (raw.created_at ?? raw.createdAt ?? "") as string,
    updatedAt: (raw.updated_at ?? raw.updatedAt ?? "") as string,
  };
}
