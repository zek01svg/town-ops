import { createFileRoute } from "@tanstack/react-router";

import { OfficerAttentionList } from "@/features/attention/officer-attention-list";

export const Route = createFileRoute("/attention")({
  component: AttentionPage,
});

function AttentionPage() {
  return <OfficerAttentionList />;
}
