import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { rescheduleJobClient } from "@/libr/api";
import { clearAuth, getAuthHeader } from "@/libr/auth-token";

const rescheduleSchema = z.object({
  caseId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  residentId: z.string().uuid(),
  newStartTime: z.string().min(1),
  newEndTime: z.string().min(1),
  appointmentId: z.string().uuid().optional(),
});

type RescheduleValues = z.infer<typeof rescheduleSchema>;

type RescheduleResponse = {
  appointmentId: string;
  caseId: string;
  status: string;
  message: string;
  newStartTime: string;
};

export function ResidentDashboard() {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<RescheduleResponse | null>(
    null
  );

  const mutation = useMutation({
    mutationFn: async (payload: RescheduleValues) => {
      const res = await rescheduleJobClient.api.cases["reschedule-job"].$post(
        { json: payload },
        { headers: getAuthHeader() }
      );
      if ((res.status as number) === 401) {
        clearAuth();
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? (err as any).message ?? `Error ${res.status}`);
      }
      return res.json() as Promise<RescheduleResponse>;
    },
  });

  const form = useForm({
    defaultValues: {
      caseId: "",
      assignmentId: "",
      residentId: "",
      newStartTime: "",
      newEndTime: "",
    },
    validators: {
      onChange: ({ value }) => {
        const res = rescheduleSchema.safeParse(value);
        if (res.success) return undefined;
        return res.error.message;
      },
    },
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      setSubmitResult(null);

      const start = new Date(value.newStartTime);
      const end = new Date(value.newEndTime);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        setSubmitError("Please provide valid start and end times.");
        return;
      }

      try {
        const payload: RescheduleValues = {
          caseId: value.caseId,
          assignmentId: value.assignmentId,
          residentId: value.residentId,
          newStartTime: start.toISOString(),
          newEndTime: end.toISOString(),
        };

        const result = await mutation.mutateAsync(payload);
        setSubmitResult(result);
      } catch (err: any) {
        setSubmitError(err?.message ?? "Reschedule failed.");
      }
    },
  });

  const statusBadge = useMemo(() => {
    if (!submitResult) return null;
    return (
      <Badge className="rounded-none uppercase text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/40">
        {submitResult.status}
      </Badge>
    );
  }, [submitResult]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-label tracking-tighter text-foreground uppercase border-b-2 border-primary inline-block pb-1">
          Resident Service Desk
        </h1>
        <p className="text-muted-foreground text-sm mt-2">
          If your contractor reported no access, choose a new slot below to reschedule the visit.
        </p>
      </div>

      <Card className="bg-surface-container border border-border rounded-none">
        <CardHeader className="flex flex-col gap-2">
          <CardTitle className="text-sm font-label uppercase tracking-widest text-primary">
            Reschedule Appointment
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase text-muted-foreground">
            <Badge variant="outline" className="rounded-none border-border">JWT Required</Badge>
            <span>Provide your case and assignment IDs.</span>
          </div>
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
              name="caseId"
              children={(field) => (
                <div className="space-y-2">
                  <label className="text-xs uppercase font-label tracking-widest text-primary">Case ID</label>
                  <Input
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="e.g. 123e4567-e89b-12d3..."
                    className="rounded-none border-border bg-surface-container"
                  />
                  {field.state.meta.errors ? (
                    <em className="text-xs text-destructive">{field.state.meta.errors.join(", ")}</em>
                  ) : null}
                </div>
              )}
            />

            <form.Field
              name="assignmentId"
              children={(field) => (
                <div className="space-y-2">
                  <label className="text-xs uppercase font-label tracking-widest text-primary">Assignment ID</label>
                  <Input
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="e.g. 223e4567-e89b-12d3..."
                    className="rounded-none border-border bg-surface-container"
                  />
                  {field.state.meta.errors ? (
                    <em className="text-xs text-destructive">{field.state.meta.errors.join(", ")}</em>
                  ) : null}
                </div>
              )}
            />

            <form.Field
              name="residentId"
              children={(field) => (
                <div className="space-y-2">
                  <label className="text-xs uppercase font-label tracking-widest text-primary">Resident ID</label>
                  <Input
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="e.g. 323e4567-e89b-12d3..."
                    className="rounded-none border-border bg-surface-container"
                  />
                  {field.state.meta.errors ? (
                    <em className="text-xs text-destructive">{field.state.meta.errors.join(", ")}</em>
                  ) : null}
                </div>
              )}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <form.Field
                name="newStartTime"
                children={(field) => (
                  <div className="space-y-2">
                    <label className="text-xs uppercase font-label tracking-widest text-primary">New Start Time</label>
                    <Input
                      type="datetime-local"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      className="rounded-none border-border bg-surface-container"
                    />
                    {field.state.meta.errors ? (
                      <em className="text-xs text-destructive">{field.state.meta.errors.join(", ")}</em>
                    ) : null}
                  </div>
                )}
              />

              <form.Field
                name="newEndTime"
                children={(field) => (
                  <div className="space-y-2">
                    <label className="text-xs uppercase font-label tracking-widest text-primary">New End Time</label>
                    <Input
                      type="datetime-local"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      className="rounded-none border-border bg-surface-container"
                    />
                    {field.state.meta.errors ? (
                      <em className="text-xs text-destructive">{field.state.meta.errors.join(", ")}</em>
                    ) : null}
                  </div>
                )}
              />
            </div>

            {submitError && (
              <p className="text-xs text-destructive uppercase tracking-widest">{submitError}</p>
            )}

            {submitResult && (
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-3 flex items-center justify-between">
                <div>
                  <p className="text-xs font-label uppercase tracking-widest text-emerald-400">{submitResult.message}</p>
                  <p className="text-[10px] text-muted-foreground font-mono mt-1">
                    New start time: {new Date(submitResult.newStartTime).toLocaleString()}
                  </p>
                </div>
                {statusBadge}
              </div>
            )}

            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
              children={([canSubmit, isSubmitting]) => (
                <Button
                  type="submit"
                  disabled={!canSubmit || mutation.isPending}
                  className="w-full rounded-none tracking-widest font-bold uppercase font-label"
                >
                  {isSubmitting || mutation.isPending ? "Submitting..." : "Confirm Reschedule"}
                </Button>
              )}
            />
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
