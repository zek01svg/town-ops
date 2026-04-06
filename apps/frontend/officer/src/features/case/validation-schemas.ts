import { z } from "zod/v4";

export const CASE_CATEGORIES = [
  { value: "LE", label: "Lighting & Electrical" },
  { value: "PL", label: "Plumbing & Sanitation" },
  { value: "LF", label: "Lift & Escalator" },
  { value: "LS", label: "Landscaping & Horticulture" },
  { value: "CL", label: "General Cleaning & Hygiene" },
  { value: "PC", label: "Pest & Vector Control" },
  { value: "PG", label: "Playgrounds & Fitness Gym" },
  { value: "ID", label: "Bulky Waste / Illegal Dumping" },
  { value: "PT", label: "Painting & Vandalism" },
  { value: "CW", label: "Civil Works & Concrete" },
  { value: "FS", label: "Fire Safety & Equipment" },
  { value: "RC", label: "Refuse Chute & Compactors" },
  { value: "SC", label: "Facade & Spalling Concrete" },
  { value: "GN", label: "General Maintenance" },
] as const;

export type CaseCategory = (typeof CASE_CATEGORIES)[number]["value"];

export const openCaseSchema = z.object({
  resident_id: z.string().uuid("Must be a valid UUID"),
  category: z.enum(
    CASE_CATEGORIES.map((c) => c.value) as [CaseCategory, ...CaseCategory[]],
    { error: "Select a category" }
  ),
  priority: z.enum(["low", "medium", "high", "emergency"]),
  description: z.string(),
  address_details: z.string(),
  postal_code: z.string(),
});

export type OpenCaseInput = z.infer<typeof openCaseSchema>;
