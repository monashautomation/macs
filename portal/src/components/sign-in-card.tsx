import type { ReactNode } from "react";
import { MaLettermark } from "@/components/ma-logo";

/** Signed-out landing card. Pass your auth library's sign-in button as `action`. */
export function SignInCard({
  appName,
  description = "Sign in with your Monash Automation account to continue.",
  action,
}: {
  appName: string;
  description?: ReactNode;
  action: ReactNode;
}) {
  return (
    <section className="mx-auto mt-12 max-w-md rounded-2xl bg-card p-8 text-center shadow-sm">
      <MaLettermark className="mx-auto size-12" />
      <h1 className="mt-4 text-2xl font-bold">{appName}</h1>
      <p className="mt-2 text-muted-foreground">{description}</p>
      <div className="mt-6 flex justify-center">{action}</div>
    </section>
  );
}
