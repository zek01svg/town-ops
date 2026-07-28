import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import {
  getReadyProofItems,
  uploadProofFile,
  useCompleteCaseMutation,
} from "../api/mutations";
import { caseKeys } from "../api/query-keys";

type ProofType = "before" | "after";
type UploadEntry = {
  id: string;
  file: File;
  preview: string;
  type: ProofType;
  state: "uploading" | "ready" | "error";
  error?: string;
};
type ReadyProofItem = {
  id: string;
  mediaUrl: string;
  type: ProofType;
};
type DisplayProofItem =
  | ReadyProofItem
  | (Pick<UploadEntry, "id" | "type" | "state" | "error"> & {
      mediaUrl: string;
    });

interface Props {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  caseId: string;
  canComplete: boolean;
}

export function CloseJobSheet({
  open,
  onOpenChange,
  caseId,
  canComplete,
}: Props) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [selectedProofIds, setSelectedProofIds] = useState<Set<string>>(
    new Set()
  );
  const [report, setReport] = useState("");
  const [error, setError] = useState<string | null>(null);
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);
  const completionKey = useRef<{ payload: string; key: string } | undefined>(
    undefined
  );
  const completeCase = useCompleteCaseMutation();
  const readyProof = useQuery({
    queryKey: caseKeys.proofItems(caseId),
    enabled: open && !!caseId,
    queryFn: () => getReadyProofItems(caseId),
  });

  useEffect(() => {
    const available = new Set([
      ...(readyProof.data ?? []).map((proof) => proof.id),
      ...uploads
        .filter((upload) => upload.state === "ready")
        .map((upload) => upload.id),
    ]);
    setSelectedProofIds(
      (selected) =>
        new Set([...selected].filter((proofId) => available.has(proofId)))
    );
  }, [readyProof.data, uploads]);

  const proofItems = useMemo(() => {
    const byId = new Map<string, DisplayProofItem>(
      (readyProof.data ?? []).flatMap((proof) => {
        if (proof.type !== "BEFORE" && proof.type !== "AFTER") {
          return [];
        }
        const displayProof: ReadyProofItem = {
          id: proof.id,
          mediaUrl: proof.mediaUrl,
          type: proof.type === "BEFORE" ? "before" : "after",
        };
        return [[proof.id, displayProof] as const];
      })
    );
    for (const upload of uploads) {
      byId.set(upload.id, {
        id: upload.id,
        type: upload.type,
        mediaUrl: upload.preview,
        state: upload.state,
        error: upload.error,
      });
    }
    return [...byId.values()];
  }, [readyProof.data, uploads]);

  function toggleProof(proofItemId: string) {
    setSelectedProofIds((selected) => {
      const next = new Set(selected);
      if (next.has(proofItemId)) next.delete(proofItemId);
      else next.add(proofItemId);
      return next;
    });
  }

  async function sendUpload(entry: UploadEntry) {
    setUploads((currentUploads) =>
      currentUploads.map((upload) =>
        upload.id === entry.id
          ? { ...upload, state: "uploading", error: undefined }
          : upload
      )
    );
    try {
      await uploadProofFile(entry.file, caseId, entry.type, entry.id);
      setUploads((currentUploads) =>
        currentUploads.map((upload) =>
          upload.id === entry.id ? { ...upload, state: "ready" } : upload
        )
      );
      setSelectedProofIds((selected) => new Set(selected).add(entry.id));
      await readyProof.refetch();
    } catch (caught) {
      setUploads((currentUploads) =>
        currentUploads.map((upload) =>
          upload.id === entry.id
            ? {
                ...upload,
                state: "error",
                error:
                  caught instanceof Error
                    ? caught.message
                    : "Proof upload failed",
              }
            : upload
        )
      );
    }
  }

  function addPhoto(file: File, type: ProofType) {
    const entry: UploadEntry = {
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      type,
      state: "uploading",
    };
    setUploads((currentUploads) => [...currentUploads, entry]);
    void sendUpload(entry);
  }

  const selected = proofItems.filter(
    (proof) =>
      selectedProofIds.has(proof.id) &&
      (!("state" in proof) || proof.state === "ready")
  );
  const hasBefore = selected.some((proof) => proof.type === "before");
  const hasAfter = selected.some((proof) => proof.type === "after");
  const canSubmit =
    canComplete &&
    report.trim().length > 0 &&
    hasBefore &&
    hasAfter &&
    !uploads.some((upload) => upload.state === "uploading");

  function handleSubmit() {
    if (!canSubmit) {
      setError("Complete the report and select ready BEFORE and AFTER proof.");
      return;
    }
    const payload = JSON.stringify({
      report: report.trim(),
      proofItemIds: selected.map((proof) => proof.id).toSorted(),
    });
    const idempotencyKey =
      completionKey.current?.payload === payload
        ? completionKey.current.key
        : crypto.randomUUID();
    completionKey.current = { payload, key: idempotencyKey };
    setError(null);
    completeCase.mutate(
      {
        caseId,
        report: report.trim(),
        proofItemIds: selected.map((proof) => proof.id),
        idempotencyKey,
      },
      {
        onSuccess: () => {
          setReport("");
          onOpenChange(false);
        },
        onError: (caught) => setError(caught.message),
      }
    );
  }

  function proofGroup(
    type: ProofType,
    label: string,
    input: RefObject<HTMLInputElement | null>
  ) {
    const items = proofItems.filter((proof) => proof.type === type);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-label uppercase tracking-widest text-foreground font-bold">
            {label}
          </span>
          <Badge variant="secondary" className="rounded-none text-[10px]">
            {items.length}
          </Badge>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.[0]) addPhoto(event.target.files[0], type);
            event.target.value = "";
          }}
        />
        <div className="flex flex-wrap gap-2">
          {items.map((proof) => {
            const isSelected = selectedProofIds.has(proof.id);
            const ready = !("state" in proof) || proof.state === "ready";
            return (
              <button
                key={proof.id}
                type="button"
                onClick={() => ready && toggleProof(proof.id)}
                disabled={!ready}
                className={`relative h-20 w-20 border ${isSelected ? "border-primary ring-1 ring-primary" : "border-border"}`}
              >
                <img
                  src={proof.mediaUrl}
                  alt={`${type} proof`}
                  className="h-full w-full object-cover"
                />
                {"state" in proof && proof.state === "uploading" && (
                  <span className="absolute inset-0 grid place-items-center bg-background/70 text-[9px] uppercase">
                    Uploading
                  </span>
                )}
                {"state" in proof && proof.state === "error" && (
                  <span className="absolute inset-0 grid place-items-center bg-destructive/80 px-1 text-[9px] uppercase text-white">
                    Retry
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <Upload className="h-4 w-4" />
            <span className="text-[9px] uppercase">Add</span>
          </button>
        </div>
        {items.some((proof) => "state" in proof && proof.state === "error") && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              for (const entry of uploads.filter(
                (upload) => upload.type === type && upload.state === "error"
              )) {
                void sendUpload(entry);
              }
            }}
            className="rounded-none text-[10px] uppercase"
          >
            <RefreshCw className="mr-2 h-3 w-3" /> Retry upload
          </Button>
        )}
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] overflow-y-auto border-l border-border bg-popover p-6 shadow-2xl sm:w-[540px]">
        <SheetHeader className="mb-6">
          <SheetTitle className="w-fit border-b-2 border-primary pb-2 font-label text-xl font-bold uppercase tracking-widest">
            Complete Job
          </SheetTitle>
          <SheetDescription className="text-xs uppercase text-muted-foreground">
            Upload immutable before/after proof and submit the completion
            report.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6">
          {proofGroup("before", "Before Photos", beforeRef)}
          {proofGroup("after", "After Photos", afterRef)}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-label uppercase tracking-widest text-foreground font-bold">
              Completion Report
            </span>
            <textarea
              placeholder="Describe the work completed, materials used, and any observations..."
              value={report}
              onChange={(event) => setReport(event.target.value)}
              className="min-h-[120px] w-full resize-none border border-border bg-surface-container p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {!canComplete && (
            <p className="text-[10px] text-muted-foreground">
              Completion is available only for your in-progress Case and
              Appointment.
            </p>
          )}
          {error && (
            <p className="text-[10px] uppercase tracking-wide text-destructive">
              {error}
            </p>
          )}
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || completeCase.isPending}
            className="w-full rounded-none bg-emerald-600 font-label text-[10px] uppercase tracking-widest text-white hover:bg-emerald-700"
          >
            <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
            {completeCase.isPending ? "Completing..." : "Complete Job"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
