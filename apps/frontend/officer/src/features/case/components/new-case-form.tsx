import { useForm } from "@tanstack/react-form";
import {
  OpenCaseInputSchema,
  CasePrioritySchema,
  MaintenanceCategorySchema,
} from "@townops/orchestration-contract";
import { useState, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useOpenCaseMutation } from "../api/mutations";
import { CASE_CATEGORIES } from "../validation-schemas";
import type { CaseCategory } from "../validation-schemas";

async function geocodePostal(postal: string): Promise<string | null> {
  const res = await fetch(
    `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${postal}&returnGeom=N&getAddrDetails=Y&pageNum=1`
  );
  if (!res.ok) return null;
  const data = await res.json();
  const result = data.results?.[0];
  if (!result) return null;
  // e.g. "BLK 201 ANG MO KIO AVENUE 3" + " SINGAPORE " + postal
  const block = result.BLK_NO ? `BLK ${result.BLK_NO} ` : "";
  const road = result.ROAD_NAME ?? "";
  return `${block}${road}, Singapore ${postal}`;
}

/**
 * Exported so a test can assert this key set still matches
 * `OpenCaseInputSchema`. The schema is `.strict()` and `onSubmit` bails
 * silently on a parse failure, so any drift here — a renamed key, an extra
 * one — makes the form do nothing on submit with no error surfaced.
 */
export const NEW_CASE_DEFAULTS = {
  residentId: "",
  category: "" as CaseCategory | "",
  priority: "MEDIUM" as (typeof CasePrioritySchema.options)[number],
  description: "",
  addressDetails: "",
  postalCode: "",
};

export function NewCaseForm({ setOpen }: { setOpen: (o: boolean) => void }) {
  const openCase = useOpenCaseMutation();
  const [geocoding, setGeocoding] = useState(false);
  const geocodeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function fillAddressFrom(postal: string) {
    setGeocoding(true);
    const address = await geocodePostal(postal);
    setGeocoding(false);
    if (address) form.setFieldValue("addressDetails", address);
  }

  const form = useForm({
    defaultValues: { ...NEW_CASE_DEFAULTS },
    validators: {
      onChange: ({ value }) => {
        const res = OpenCaseInputSchema.safeParse(value);
        if (res.success) return undefined;
        return res.error.message;
      },
    },
    onSubmit: async ({ value }) => {
      const parsed = OpenCaseInputSchema.safeParse(value);
      if (!parsed.success) return;
      await openCase.mutateAsync(parsed.data);
      setOpen(false);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void form.handleSubmit();
      }}
      className="space-y-6 mt-6 p-1"
    >
      <form.Field
        name="residentId"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">
              Resident UUID
            </label>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="e.g. 123e4567-e89b-12d3..."
              className="rounded-none border-border bg-surface-container"
            />
            {field.state.meta.errors.length > 0 ? (
              <em className="text-xs text-destructive">
                {field.state.meta.errors.join(", ")}
              </em>
            ) : null}
          </div>
        )}
      />
      <form.Field
        name="category"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">
              Category
            </label>
            <Select
              value={field.state.value}
              onValueChange={(v) => {
                const picked = MaintenanceCategorySchema.safeParse(v);
                if (picked.success) field.handleChange(picked.data);
              }}
            >
              <SelectTrigger className="rounded-none border-border bg-surface-container w-full">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {CASE_CATEGORIES.map((cat) => (
                  <SelectItem key={cat.value} value={cat.value}>
                    <span className="font-mono text-xs text-muted-foreground mr-2">
                      {cat.value}
                    </span>
                    {cat.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {field.state.meta.errors.length > 0 ? (
              <em className="text-xs text-destructive">
                {field.state.meta.errors.join(", ")}
              </em>
            ) : null}
          </div>
        )}
      />

      <form.Field
        name="description"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">
              Description
            </label>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Case details..."
              className="rounded-none border-border bg-surface-container"
            />
            {field.state.meta.errors.length > 0 ? (
              <em className="text-xs text-destructive">
                Description is required
              </em>
            ) : null}
          </div>
        )}
      />

      <form.Field
        name="postalCode"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">
              Postal Code
            </label>
            <Input
              value={field.state.value}
              maxLength={6}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, "");
                field.handleChange(val);
                if (geocodeTimeout.current)
                  clearTimeout(geocodeTimeout.current);
                if (val.length === 6) {
                  geocodeTimeout.current = setTimeout(
                    () => void fillAddressFrom(val),
                    300
                  );
                }
              }}
              placeholder="e.g. 560201"
              className="rounded-none border-border bg-surface-container"
            />
            {field.state.value.length > 0 && field.state.value.length < 6 ? (
              <em className="text-xs text-destructive">
                Postal code must be 6 digits
              </em>
            ) : null}
          </div>
        )}
      />

      <form.Field
        name="addressDetails"
        children={(field) => (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase font-label tracking-widest text-primary">
                Address
              </label>
              {geocoding && (
                <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground animate-pulse">
                  Looking up...
                </span>
              )}
            </div>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Auto-filled from postal code"
              className="rounded-none border-border bg-surface-container"
            />
          </div>
        )}
      />

      <form.Field
        name="priority"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">
              Priority
            </label>
            <div className="flex gap-2">
              {CasePrioritySchema.options.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={field.state.value === p ? "default" : "outline"}
                  onClick={() => field.handleChange(p)}
                  className="rounded-none capitalize flex-1 border-border"
                >
                  {p.toLowerCase()}
                </Button>
              ))}
            </div>
            {field.state.meta.errors.length > 0 ? (
              <em className="text-xs text-destructive">
                {field.state.meta.errors.join(", ")}
              </em>
            ) : null}
          </div>
        )}
      />

      <form.Subscribe
        selector={(state) => [state.canSubmit, state.isSubmitting]}
        children={([canSubmit, isSubmitting]) => (
          <Button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-none tracking-widest font-bold uppercase font-label"
          >
            {isSubmitting ? "Opening..." : "Open Case"}
          </Button>
        )}
      />
    </form>
  );
}
