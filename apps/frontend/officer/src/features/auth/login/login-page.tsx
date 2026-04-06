"use client"

import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { cn } from "@/libr/utils";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import { LayoutBottomIcon } from "@hugeicons/core-free-icons";
import { env } from "@/env";
import { auth } from "@/libr/auth";

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [error, setError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    onSubmit: async ({ value }) => {
      try {
        setError(null);
        const signInRes = await auth.signIn.email({
          email: value.email,
          password: value.password,
        });
        if (signInRes.error) {
          setError(signInRes.error.message ?? "Login failed.");
          return;
        }
        // Fetch JWT from the token endpoint using the session cookie
        const tokenRes = await fetch(`${env.VITE_AUTH_URL}/api/auth/token`, {
          method: "GET",
          credentials: "include",
        });
        if (!tokenRes.ok) {
          setError(`Token fetch failed: ${tokenRes.status}`);
          return;
        }
        const { token } = await tokenRes.json();
        if (!token) {
          setError("No token returned from auth server.");
          return;
        }
        localStorage.setItem("jwt", token);
        window.location.reload();
      } catch (err: any) {
        setError(err?.message ?? "Login failed. Check your credentials.");
      }
    },
  });

  return (
    <div className={cn("flex flex-col gap-6 w-full max-w-md bg-card border border-border p-6 rounded-lg shadow-xl border-t-4 border-t-indigo-500", className)} {...props}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
      >
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex size-8 items-center justify-center rounded-md text-indigo-400">
              <HugeiconsIcon icon={LayoutBottomIcon} strokeWidth={2} className="size-6" />
            </div>
            <h1 className="text-xl font-bold text-foreground">Welcome to TownOps</h1>
            <FieldDescription className="text-muted-foreground">
              Enter your credentials to access your dashboard workspace.
            </FieldDescription>
          </div>

          {error && <p className="text-destructive text-sm text-center">{error}</p>}

          <form.Field
            name="email"
            children={(field) => (
              <Field orientation="vertical">
                <FieldLabel htmlFor={field.name} className="text-foreground">Email</FieldLabel>
                <FieldContent>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    type="email"
                    placeholder="officer@townops.dev"
                    className="bg-background border-border focus-visible:ring-indigo-500"
                    required
                  />
                </FieldContent>
              </Field>
            )}
          />

          <form.Field
            name="password"
            children={(field) => (
              <Field orientation="vertical">
                <FieldLabel htmlFor={field.name} className="text-foreground">Password</FieldLabel>
                <FieldContent>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    type="password"
                    className="bg-background border-border focus-visible:ring-indigo-500"
                    required
                  />
                </FieldContent>
              </Field>
            )}
          />

          <Field>
            <Button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white">Login</Button>
          </Field>
        </FieldGroup>
      </form>
      <FieldDescription className="px-6 text-center text-muted-foreground">
        By clicking continue, you agree to our <span className="text-muted-foreground underline">Terms of Service</span>{" "}
        and <span className="text-muted-foreground underline">Privacy Policy</span>.
      </FieldDescription>
    </div>
  );
}
