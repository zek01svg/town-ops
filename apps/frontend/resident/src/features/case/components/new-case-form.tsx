import { useForm } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { openCaseSchema } from "../validation-schemas";

export function NewCaseForm({ setOpen }: { setOpen: (o: boolean) => void }) {
  const form = useForm({
    defaultValues: {
      resident_id: "",
      category: "",
      priority: "medium" as "low" | "medium" | "high" | "emergency",
      description: "",
      address_details: "",
      postal_code: "",
    },
    validators: {
      onChange: ({ value }) => {
        const res = openCaseSchema.safeParse(value);
        if (res.success) return undefined;
        return res.error.message;
      },
    },
    onSubmit: async ({ value }) => {
      console.log("Submitting successfully:", value);
      await new Promise((r) => setTimeout(r, 1000));
      setOpen(false);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-6 mt-6 p-1"
    >
      <form.Field
        name="resident_id"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">Resident UUID</label>
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
        name="category"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">Category</label>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="e.g. Plumbing"
              className="rounded-none border-border bg-surface-container"
            />
            {field.state.meta.errors ? (
              <em className="text-xs text-destructive">{field.state.meta.errors.join(", ")}</em>
            ) : null}
          </div>
        )}
      />

      <form.Field
        name="description"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">Description</label>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Case details..."
              className="rounded-none border-border bg-surface-container"
            />
          </div>
        )}
      />

      <form.Field
        name="address_details"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">Address</label>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="e.g. 123 Main St, #05-01"
              className="rounded-none border-border bg-surface-container"
            />
          </div>
        )}
      />

      <form.Field
        name="postal_code"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">Postal Code</label>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="e.g. 123456"
              className="rounded-none border-border bg-surface-container"
            />
          </div>
        )}
      />

      <form.Field
        name="priority"
        children={(field) => (
          <div className="space-y-2">
            <label className="text-xs uppercase font-label tracking-widest text-primary">Priority</label>
            <div className="flex gap-2">
              {["low", "medium", "high", "emergency"].map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={field.state.value === p ? "default" : "outline"}
                  onClick={() => field.handleChange(p as any)}
                  className="rounded-none capitalize flex-1 border-border"
                >
                  {p}
                </Button>
              ))}
            </div>
            {field.state.meta.errors ? (
              <em className="text-xs text-destructive">{field.state.meta.errors.join(", ")}</em>
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
