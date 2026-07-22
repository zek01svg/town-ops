import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  MaintenanceCategorySchema,
  ResidentOpenCaseInputSchema,
} from "@townops/orchestration-contract";
import type { CaseDto } from "@townops/orchestration-contract";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getCase, getMe, openCase } from "@/libr/gateway";

const priorities = ["LOW", "MEDIUM", "HIGH", "EMERGENCY"] as const;

export function ResidentCaseDesk() {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openedCaseId, setOpenedCaseId] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    // While the profile is still provisioning, keep asking so the form unlocks
    // on its own once the Workflow finishes.
    refetchInterval: (query) =>
      query.state.data?.provisioningState === "PROVISIONING" ? 2000 : false,
  });

  const openedCase = useQuery({
    queryKey: ["case", openedCaseId],
    queryFn: () => getCase(openedCaseId as string),
    enabled: openedCaseId !== null,
  });

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof openCase>[0]) =>
      // A fresh key per submission; a retry of the same submission would reuse
      // it and reattach rather than open a second Case.
      openCase(input, crypto.randomUUID()),
  });

  const form = useForm({
    defaultValues: {
      category: "PL",
      priority: "MEDIUM" as (typeof priorities)[number],
      description: "",
      postalCode: "",
    },
    validators: {
      onChange: ({ value }) => {
        const result = ResidentOpenCaseInputSchema.safeParse(value);
        return result.success ? undefined : result.error.message;
      },
    },
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      setOpenedCaseId(null);
      try {
        const result = await mutation.mutateAsync(
          ResidentOpenCaseInputSchema.parse(value)
        );
        setOpenedCaseId(result.data.id);
        form.reset();
      } catch (caught: any) {
        setSubmitError(caught?.message ?? "Could not open the Case.");
      }
    },
  });

  const isProvisioning = me.data?.provisioningState === "PROVISIONING";

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-label tracking-tighter text-foreground uppercase border-b-2 border-primary inline-block pb-1">
          Report Maintenance
        </h1>
        <p className="text-muted-foreground text-sm mt-2">
          Open a Case for your address. TownOps allocates a contractor for you.
        </p>
      </div>

      {me.isError && (
        <p className="text-xs text-destructive uppercase tracking-widest">
          {(me.error).message}
        </p>
      )}

      {isProvisioning && (
        <div className="border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-xs font-label uppercase tracking-widest text-amber-400">
            Setting up your resident profile
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            This usually takes a moment. You can open a Case as soon as it is
            ready.
          </p>
        </div>
      )}

      <Card className="bg-surface-container border border-border rounded-none">
        <CardHeader>
          <CardTitle className="text-sm font-label uppercase tracking-widest text-primary">
            New Case
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
            className="space-y-5"
          >
            <form.Field
              name="category"
              children={(field) => (
                <div className="space-y-2">
                  <label className="text-xs uppercase font-label tracking-widest text-primary">
                    Category
                  </label>
                  <select
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    className="w-full rounded-none border border-border bg-surface-container p-2 text-sm"
                  >
                    {MaintenanceCategorySchema.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
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
                    placeholder="What needs fixing?"
                    className="rounded-none border-border bg-surface-container"
                  />
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
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="e.g. 123456"
                    inputMode="numeric"
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
                    {priorities.map((priority) => (
                      <Button
                        key={priority}
                        type="button"
                        variant={
                          field.state.value === priority ? "default" : "outline"
                        }
                        onClick={() => field.handleChange(priority)}
                        className="rounded-none capitalize flex-1 border-border"
                      >
                        {priority.toLowerCase()}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            />

            {submitError && (
              <p className="text-xs text-destructive uppercase tracking-widest">
                {submitError}
              </p>
            )}

            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
              children={([canSubmit, isSubmitting]) => (
                <Button
                  type="submit"
                  disabled={
                    !canSubmit || mutation.isPending || !me.data?.canOpenCases
                  }
                  className="w-full rounded-none tracking-widest font-bold uppercase font-label"
                >
                  {isSubmitting || mutation.isPending
                    ? "Opening..."
                    : isProvisioning
                      ? "Waiting for your profile"
                      : "Open Case"}
                </Button>
              )}
            />
          </form>
        </CardContent>
      </Card>

      {openedCase.data && <OpenedCase record={openedCase.data} />}
    </div>
  );
}

function OpenedCase({ record }: { record: CaseDto }) {
  return (
    <Card className="bg-surface-container border border-emerald-500/40 rounded-none">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-label uppercase tracking-widest text-emerald-400">
          Case Opened
        </CardTitle>
        <Badge className="rounded-none uppercase text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/40">
          {record.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-1 text-xs text-muted-foreground">
        <p className="font-mono">{record.id}</p>
        <p>
          {record.category} · {record.priority} · {record.postalCode}
        </p>
        <p>{record.description}</p>
      </CardContent>
    </Card>
  );
}
