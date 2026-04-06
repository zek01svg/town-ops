import { useRef, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, X, CheckCircle2 } from "lucide-react";
import { auth } from "@/libr/auth";
import { uploadProofFile, useCloseCaseMutation } from "../api/mutations";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  caseId: string;
}

type PhotoEntry = { file: File; preview: string; type: "before" | "after" };

export function CloseJobSheet({ open, onOpenChange, caseId }: Props) {
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [report, setReport] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);
  const closeCase = useCloseCaseMutation();

  function addPhoto(file: File, type: "before" | "after") {
    const preview = URL.createObjectURL(file);
    setPhotos((prev) => [...prev, { file, preview, type }]);
  }

  function removePhoto(idx: number) {
    setPhotos((prev) => {
      URL.revokeObjectURL(prev[idx].preview);
      return prev.filter((_, i) => i !== idx);
    });
  }

  async function handleSubmit() {
    if (photos.length === 0) { setError("Add at least one photo."); return; }
    if (!report.trim()) { setError("Write a completion report."); return; }
    setError(null);
    setUploading(true);

    try {
      const session = await auth.getSession();
      const uploaderId = session?.data?.user?.id ?? "unknown";

      const proofItems = await Promise.all(
        photos.map((p) => uploadProofFile(p.file, caseId, uploaderId, p.type, report))
      );

      closeCase.mutate(
        {
          case_id: caseId,
          uploader_id: uploaderId,
          proof_items: proofItems.map((url, i) => ({
            media_url: url,
            type: photos[i].type,
            remarks: report,
          })),
          final_status: "completed",
        },
        {
          onSuccess: () => {
            setPhotos([]);
            setReport("");
            onOpenChange(false);
          },
          onError: (e) => setError(e.message),
        }
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  const beforePhotos = photos.filter((p) => p.type === "before");
  const afterPhotos = photos.filter((p) => p.type === "after");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] sm:w-[540px] border-l border-border bg-popover p-6 shadow-2xl overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle className="text-xl uppercase tracking-widest font-bold font-label border-b-2 border-primary pb-2 w-fit">
            Close Job
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground uppercase">
            Attach before/after photos and submit your completion report.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6">
          {/* Before Photos */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-label uppercase tracking-widest text-foreground font-bold">
                Before Photos
              </span>
              <Badge variant="secondary" className="rounded-none text-[10px]">{beforePhotos.length}</Badge>
            </div>
            <input ref={beforeRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) addPhoto(e.target.files[0], "before"); e.target.value = ""; }}
            />
            <div className="flex flex-wrap gap-2">
              {beforePhotos.map((p, i) => (
                <div key={i} className="relative w-20 h-20 border border-border">
                  <img src={p.preview} alt="uploaded proof" className="w-full h-full object-cover" />
                  <button onClick={() => removePhoto(photos.indexOf(p))}
                    className="absolute top-0.5 right-0.5 bg-destructive text-white rounded-full p-0.5">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
              <button onClick={() => beforeRef.current?.click()}
                className="w-20 h-20 border border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                <Upload className="h-4 w-4" />
                <span className="text-[9px] uppercase">Add</span>
              </button>
            </div>
          </div>

          {/* After Photos */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-label uppercase tracking-widest text-foreground font-bold">
                After Photos
              </span>
              <Badge variant="secondary" className="rounded-none text-[10px]">{afterPhotos.length}</Badge>
            </div>
            <input ref={afterRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) addPhoto(e.target.files[0], "after"); e.target.value = ""; }}
            />
            <div className="flex flex-wrap gap-2">
              {afterPhotos.map((p, i) => (
                <div key={i} className="relative w-20 h-20 border border-border">
                  <img src={p.preview} alt="uploaded proof" className="w-full h-full object-cover" />
                  <button onClick={() => removePhoto(photos.indexOf(p))}
                    className="absolute top-0.5 right-0.5 bg-destructive text-white rounded-full p-0.5">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
              <button onClick={() => afterRef.current?.click()}
                className="w-20 h-20 border border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                <Upload className="h-4 w-4" />
                <span className="text-[9px] uppercase">Add</span>
              </button>
            </div>
          </div>

          {/* Completion Report */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-label uppercase tracking-widest text-foreground font-bold">
              Completion Report
            </span>
            <textarea
              placeholder="Describe the work completed, materials used, and any observations..."
              value={report}
              onChange={(e) => setReport(e.target.value)}
              className="w-full rounded-none border border-border bg-surface-container min-h-[120px] text-sm resize-none p-3 focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {error && (
            <p className="text-[10px] text-destructive uppercase tracking-wide">{error}</p>
          )}

          <Button
            onClick={handleSubmit}
            disabled={uploading || closeCase.isPending}
            className="rounded-none uppercase text-[10px] font-label tracking-widest w-full bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
            {uploading || closeCase.isPending ? "Submitting..." : "Submit & Close Job"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
