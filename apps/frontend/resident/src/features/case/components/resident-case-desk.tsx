import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MaintenanceCategorySchema,
  ResidentOpenCaseInputSchema,
} from "@townops/orchestration-contract";
import type { CaseDto } from "@townops/orchestration-contract";
import { History, User } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  getCase,
  getMe,
  getTimeline,
  listCases,
  openCase,
} from "@/libr/gateway";

import { useCancelCaseMutation } from "../api/mutations";
import { caseKeys } from "../api/query-keys";

const priorities = ["LOW", "MEDIUM", "HIGH", "EMERGENCY"] as const;

export function ResidentCaseDesk() {
  const qc = useQueryClient();
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

  const cases = useQuery({ queryKey: caseKeys.list, queryFn: listCases });

  const openedCase = useQuery({
    queryKey: caseKeys.detail(openedCaseId ?? ""),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.list }),
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
      } catch (caught: unknown) {
        setSubmitError(
          caught instanceof Error ? caught.message : "Could not open the Case."
        );
      }
    },
  });

  const isProvisioning = me.data?.provisioningState === "PROVISIONING";
  const caseList = cases.data ?? [];

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
            Your Cases
          </CardTitle>
        </CardHeader>
        <CardContent>
          {cases.isLoading ? (
            <p className="text-xs text-muted-foreground uppercase tracking-widest">
              Loading your cases…
            </p>
          ) : cases.isError ? (
            <p className="text-xs text-destructive uppercase tracking-widest">
              {cases.error.message}
            </p>
          ) : caseList.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              You have not opened a Case yet.
            </p>
          ) : (
            <div className="divide-y divide-border border border-border">
              {caseList.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => setOpenedCaseId(record.id)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-muted ${
                    openedCaseId === record.id ? "bg-muted" : ""
                  }`}
                >
                  <span className="font-label uppercase tracking-widest">
                    {record.category} · {record.priority}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {record.postalCode}
                  </span>
                  <Badge
                    variant="outline"
                    className="rounded-none border-border text-[10px] uppercase"
                  >
                    {record.status}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {record.createdAt
                      ? new Date(record.createdAt).toLocaleDateString()
                      : "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {openedCase.isError && (
            <p className="mt-3 text-xs text-destructive uppercase tracking-widest">
              {openedCase.error.message}
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

  const timeline = useQuery({
    queryKey: caseKeys.timeline(record.id),
    queryFn: () => getTimeline(record.id),
  });

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

        <div className="mt-4 space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-1.5 text-[10px] font-label uppercase tracking-widest text-primary">
            <History className="h-3 w-3" />
            Activity
          </div>
          {(timeline.data?.missingSources.length ?? 0) > 0 && (
            <p className="text-[10px] uppercase tracking-widest text-amber-400">
              Some history could not be loaded.
            </p>
          )}
          {timeline.isLoading ? (
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Loading history…
            </p>
          ) : timeline.isError ? (
            <p className="text-[10px] uppercase tracking-widest text-destructive">
              Could not load activity history.
            </p>
          ) : !timeline.data || timeline.data.events.length === 0 ? (
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              No activity recorded yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {timeline.data.events.map((event, i) => (
                <li key={`${event.timestamp}-${i}`} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-foreground">
                      {event.type}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {new Date(event.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-primary">
                    <User className="h-2.5 w-2.5" />
                    {event.actor}
                  </div>
                  <p className="leading-relaxed text-muted-foreground">
                    {event.description}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
