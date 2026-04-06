export type Urgency = "low" | "medium" | "high" | "emergency";
export type CaseStatus =
  | "pending"
  | "assigned"
  | "dispatched"
  | "in_progress"
  | "pending_resident_input"
  | "completed"
  | "cancelled"
  | "escalated";

export type CaseItem = {
  id: string;
  residentId: string;
  address: string;
  category: string;
  priority: Urgency;
  status: CaseStatus;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type CaseContent = {
  address: string;
  description: string;
  priority: Urgency;
  sla: string;
};
