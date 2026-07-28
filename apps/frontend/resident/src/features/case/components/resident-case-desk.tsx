import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  MaintenanceCategorySchema,
  ResidentOpenCaseInputSchema,
} from "@townops/orchestration-contract";
import type { CaseDto } from "@townops/orchestration-contract";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod/v4";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getCase, getMe, openCase } from "@/libr/gateway";

import { useCancelCaseMutation } from "../api/mutations";

const priorities = ["LOW", "MEDIUM", "HIGH", "EMERGENCY"] as const;

export function ResidentCaseDesk() {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openedCaseId, setOpenedCaseId] = useState<string | null>(null);
  const [caseIdToLoad, setCaseIdToLoad] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);

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
    queryFn: () => {
      if (!openedCaseId) throw new Error("Case ID is required.");
      return getCase(openedCaseId);
    },
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
      setLookupError(null);
      setOpenedCaseId(null);
      try {
        const result = await mutation.mutateAsync(
          ResidentOpenCaseInputSchema.parse(value)
        );
        setOpenedCaseId(result.data.id);
        form.reset();
      } catch (caught: unknown) {
        setSubmitError(
          caught instanceof Error ? caught.message : "Could not open the Case."
        );
      }
    },
  });

  const isProvisioning = me.data?.provisioningState === "PROVISIONING";
  const loadedCaseError =
    lookupError ?? (openedCase.isError ? openedCase.error.message : null);

  function handleLoadCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const caseId = z.uuid().safeParse(caseIdToLoad.trim());
    if (!caseId.success) {
      setLookupError("Case ID must be a UUID.");
      return;
    }
    setLookupError(null);
    setOpenedCaseId(caseId.data);
  }

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
          {me.error.message}
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
            Find Existing Case
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLoadCase} className="flex gap-2">
            <Input
              value={caseIdToLoad}
              onChange={(event) => setCaseIdToLoad(event.target.value)}
              placeholder="Case UUID"
              aria-label="Case ID"
              className="rounded-none border-border bg-surface-container"
            />
            <Button
              type="submit"
              disabled={openedCase.isFetching}
              className="rounded-none uppercase font-label"
            >
              {openedCase.isFetching ? "Loading..." : "Load"}
            </Button>
          </form>
          {loadedCaseError && (
            <p className="mt-3 text-xs text-destructive uppercase tracking-widest">
              {loadedCaseError}
            </p>
          )}
        </CardContent>
      </Card>

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
              void form.handleSubmit();
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

export function isResidentCaseCancellable(status: CaseDto["status"]) {
  return !["IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(status);
}

function OpenedCase({ record }: { record: CaseDto }) {
  const cancelCase = useCancelCaseMutation();
  const cancellationKey = useRef<string | undefined>(undefined);
  const [reason, setReason] = useState("");
  const cancellable = isResidentCaseCancellable(record.status);

  function handleCancel() {
    if (!reason.trim()) return;
    const idempotencyKey = cancellationKey.current ?? crypto.randomUUID();
    cancellationKey.current = idempotencyKey;
    cancelCase.mutate(
      { caseId: record.id, input: { reason }, idempotencyKey },
      {
        onSuccess: () => {
          cancellationKey.current = undefined;
          setReason("");
        },
      }
    );
  }

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
        {cancellable && (
          <div className="mt-4 space-y-2 border-t border-border pt-3">
            <label className="block text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Cancellation reason
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                rows={2}
                className="mt-1 w-full border border-border bg-background px-2 py-1 text-xs text-foreground normal-case tracking-normal"
              />
            </label>
            <Button
              onClick={handleCancel}
              disabled={cancelCase.isPending || !reason.trim()}
              variant="outline"
              className="w-full rounded-none text-[10px] font-label uppercase tracking-widest"
            >
              {cancelCase.isPending ? "Cancelling…" : "Cancel Case"}
            </Button>
            {cancelCase.isError && (
              <p className="text-[10px] text-destructive uppercase">
                {cancelCase.error.message}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
