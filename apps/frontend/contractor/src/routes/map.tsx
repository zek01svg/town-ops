import { createFileRoute, Navigate } from "@tanstack/react-router";
import {
  APIProvider,
  Map,
  AdvancedMarker,
  Pin,
  InfoWindow,
} from "@vis.gl/react-google-maps";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { caseQueries } from "@/features/case/api/queries";
import { env } from "@/env";
import { Clock } from "lucide-react";
import { useState } from "react";
import { useTheme } from "@/providers/theme-provider";

export const Route = createFileRoute("/map")({
  component: MapPage,
});

// Ang Mo Kio, Singapore
const AMK_CENTER = { lat: 1.3691, lng: 103.8454 };

// Dummy coordinates near AMK for cases without geocoding
const DUMMY_OFFSETS: Array<{ lat: number; lng: number }> = [
  { lat: 0.005, lng: 0.003 },
  { lat: -0.003, lng: 0.008 },
  { lat: 0.008, lng: -0.004 },
  { lat: -0.006, lng: -0.006 },
  { lat: 0.002, lng: 0.012 },
  { lat: 0.01, lng: 0.001 },
  { lat: -0.009, lng: 0.005 },
  { lat: 0.004, lng: -0.01 },
  { lat: -0.001, lng: -0.012 },
  { lat: 0.007, lng: 0.009 },
];

function priorityColor(priority: string) {
  switch (priority) {
    case "emergency":
      return { bg: "#ef4444", glyph: "#fff" };
    case "high":
      return { bg: "#f97316", glyph: "#fff" };
    case "medium":
      return { bg: "#3b82f6", glyph: "#fff" };
    default:
      return { bg: "#6b7280", glyph: "#fff" };
  }
}

function MapPage() {
  const hasJwt =
    typeof window !== "undefined" && !!localStorage.getItem("jwt");
  if (!hasJwt) {
    return <Navigate to="/" replace />;
  }

  const { theme } = useTheme();
  const { data: cases = [], isLoading } = useQuery(caseQueries.all());
  const active = cases.filter(
    (c) => !["completed", "cancelled"].includes(c.status)
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedCase = active.find((c) => c.id === selectedId);

  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-label tracking-tighter text-foreground uppercase border-b-2 border-primary inline-block pb-1">
          Map View
        </h1>
        <p className="text-muted-foreground text-sm mt-2">
          Spatial overview of active case locations.
        </p>
      </div>

      <div className="flex gap-6">
        {/* Map */}
        <div
          className="flex-1 border border-border overflow-hidden"
          style={{ minHeight: "520px" }}
        >
          <APIProvider apiKey={env.VITE_GOOGLE_MAPS_API_KEY}>
            <Map
              style={{ width: "100%", height: "520px" }}
              defaultCenter={AMK_CENTER}
              defaultZoom={14}
              colorScheme={isDark ? "DARK" : "LIGHT"}
              mapId="townops-map"
              gestureHandling="greedy"
              disableDefaultUI={false}
            >
              {!isLoading &&
                active.map((c, i) => {
                  const offset = DUMMY_OFFSETS[i % DUMMY_OFFSETS.length];
                  const position = {
                    lat: AMK_CENTER.lat + offset.lat,
                    lng: AMK_CENTER.lng + offset.lng,
                  };
                  const colors = priorityColor(c.priority);
                  return (
                    <AdvancedMarker
                      key={c.id}
                      position={position}
                      onClick={() =>
                        setSelectedId(selectedId === c.id ? null : c.id)
                      }
                    >
                      <Pin
                        background={colors.bg}
                        glyphColor={colors.glyph}
                        borderColor={colors.bg}
                      />
                    </AdvancedMarker>
                  );
                })}

              {selectedCase && (
                <InfoWindow
                  position={{
                    lat:
                      AMK_CENTER.lat +
                      DUMMY_OFFSETS[
                        active.findIndex((c) => c.id === selectedId) %
                          DUMMY_OFFSETS.length
                      ].lat,
                    lng:
                      AMK_CENTER.lng +
                      DUMMY_OFFSETS[
                        active.findIndex((c) => c.id === selectedId) %
                          DUMMY_OFFSETS.length
                      ].lng,
                  }}
                  onCloseClick={() => setSelectedId(null)}
                >
                  <div className="flex flex-col gap-1 min-w-[160px]">
                    <span className="text-xs font-mono font-bold">
                      {selectedCase.id.slice(0, 8)}...
                    </span>
                    <span className="text-xs text-gray-600">
                      {selectedCase.address || "No address"}
                    </span>
                    <div className="flex gap-1 mt-1">
                      <span
                        className="text-[10px] uppercase font-bold px-1 py-0.5 rounded"
                        style={{
                          background: priorityColor(selectedCase.priority).bg,
                          color: "#fff",
                        }}
                      >
                        {selectedCase.priority}
                      </span>
                      <span className="text-[10px] uppercase font-bold px-1 py-0.5 rounded bg-gray-200 text-gray-700">
                        {selectedCase.status}
                      </span>
                    </div>
                    <span className="text-[10px] text-gray-500">
                      {new Date(selectedCase.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </InfoWindow>
              )}
            </Map>
          </APIProvider>
        </div>

        {/* Side panel */}
        <div className="w-72 shrink-0 flex flex-col gap-3">
          <div className="border border-border bg-surface-container p-4 flex flex-col gap-1">
            <span className="font-label text-[10px] uppercase tracking-widest text-muted-foreground">
              Active Pins
            </span>
            <span className="text-3xl font-bold text-primary">
              {active.length}
            </span>
          </div>
          <div className="border border-border bg-surface-container p-4 flex flex-col gap-1">
            <span className="font-label text-[10px] uppercase tracking-widest text-muted-foreground">
              High Priority
            </span>
            <span className="text-3xl font-bold text-destructive">
              {
                active.filter(
                  (c) => c.priority === "high" || c.priority === "emergency"
                ).length
              }
            </span>
          </div>

          <div className="border border-border bg-surface-container flex flex-col flex-1 overflow-hidden">
            <div className="p-4 border-b border-border">
              <span className="font-label text-[10px] uppercase tracking-widest text-muted-foreground">
                Active Cases
              </span>
            </div>
            <div
              className="flex flex-col overflow-y-auto"
              style={{ maxHeight: "340px" }}
            >
              {active.length === 0 ? (
                <div className="p-4 text-[10px] text-muted-foreground font-label uppercase tracking-widest text-center">
                  No active cases
                </div>
              ) : (
                active.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="p-3 border-b border-border/50 flex flex-col gap-1 hover:bg-muted/50 transition-colors text-left w-full"
                    onClick={() =>
                      setSelectedId(selectedId === c.id ? null : c.id)
                    }
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-primary">
                        {c.id.slice(0, 8)}...
                      </span>
                      <Badge
                        className={`rounded-none text-[9px] uppercase ${
                          c.priority === "high" || c.priority === "emergency"
                            ? "bg-destructive/20 text-destructive border-destructive/30"
                            : "bg-muted text-foreground border-border"
                        }`}
                      >
                        {c.priority}
                      </Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {c.address || "No address"}
                    </p>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock className="h-2.5 w-2.5" />
                      <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
