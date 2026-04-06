import { queryOptions } from "@tanstack/react-query";
import { env } from "@/env";
import { fetchWithAuth } from "@/libr/auth-token";

export const auditKeys = {
  timeline: (caseId: string) => ["audit", "timeline", caseId] as const,
};

export interface TimelineEvent {
  type: string;
  actor: string;
  timestamp: string;
  description: string;
}

export const auditQueries = {
  timeline: (caseId: string) =>
    queryOptions({
      queryKey: auditKeys.timeline(caseId),
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async (): Promise<TimelineEvent[]> => {
        const auth = env.VITE_AUTH_URL;

        const safe = async (url: string) => {
          try {
            const res = await fetchWithAuth(url, {}, auth);
            if (!res.ok) {
              console.warn(`[audit] ${url} -> ${res.status}`);
              return null;
            }
            return res;
          } catch (e) {
            console.error(`[audit] ${url} -> network error`, e);
            return null;
          }
        };

        const [assignmentRes, appointmentRes, alertRes, proofRes, historyRes] =
          await Promise.all([
            safe(`${env.VITE_ASSIGNMENT_ATOM_URL}/api/assignments/${caseId}`),
            safe(`${env.VITE_APPOINTMENT_ATOM_URL}/api/appointments/${caseId}`),
            safe(`${env.VITE_ALERT_ATOM_URL}/api/alerts/case/${caseId}`),
            safe(`${env.VITE_PROOF_ATOM_URL}/api/proof/${caseId}`),
            safe(`${env.VITE_ASSIGNMENT_ATOM_URL}/api/assignments/${caseId}/history`),
          ]);

        const events: TimelineEvent[] = [];

        if (assignmentRes?.ok) {
          const { assignments: a } = await assignmentRes.json();
          if (a) {
            events.push({
              type: "Assigned",
              actor: `Contractor ${a.contractorId.slice(0, 8)}...`,
              timestamp: a.assignedAt,
              description: `Job assigned via ${a.source.replace(/_/g, " ").toLowerCase()}. Response due ${new Date(a.responseDueAt).toLocaleString()}.`,
            });
            if (a.acceptedAt) {
              events.push({
                type: "Accepted",
                actor: `Contractor ${a.contractorId.slice(0, 8)}...`,
                timestamp: a.acceptedAt,
                description: "Assignment accepted by contractor.",
              });
            }
          }
        }

        if (historyRes?.ok) {
          const { history } = await historyRes.json();
          for (const h of history ?? []) {
            events.push({
              type: "Status Change",
              actor: h.changedBy,
              timestamp: h.changedAt,
              description: `${h.fromStatus ?? "-"} -> ${h.toStatus}${h.reason ? `: ${h.reason}` : ""}`,
            });
          }
        }

        if (appointmentRes?.ok) {
          const data = await appointmentRes.json();
          for (const appt of data.appointments ?? data ?? []) {
            events.push({
              type: "Appointment",
              actor: "System",
              timestamp: appt.createdAt,
              description: `Appointment ${appt.status}. Scheduled ${new Date(appt.startTime).toLocaleString()} - ${new Date(appt.endTime).toLocaleTimeString()}.`,
            });
          }
        }

        if (alertRes?.ok) {
          const data = await alertRes.json();
          for (const alert of data.alerts ?? data ?? []) {
            events.push({
              type: "Alert Sent",
              actor: "System",
              timestamp: alert.sentAt,
              description: alert.message,
            });
          }
        }

        if (proofRes?.ok) {
          const data = await proofRes.json();
          for (const proof of data.proof ?? []) {
            events.push({
              type: "Proof Uploaded",
              actor: `Uploader ${proof.uploaderId.slice(0, 8)}...`,
              timestamp: proof.createdAt,
              description: `${proof.type} photo uploaded${proof.remarks ? `: ${proof.remarks}` : ""}.`,
            });
          }
        }

        return events.sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
      },
    }),
};
