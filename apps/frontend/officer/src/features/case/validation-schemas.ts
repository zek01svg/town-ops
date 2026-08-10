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
