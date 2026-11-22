"use client";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignInButton({ callbackPath = "/" }: { callbackPath?: string }) {
  return (
    <Button onClick={() => authClient.signIn.social({ provider: "authentik", callbackURL: callbackPath })}>
      Sign in with Monash Automation
    </Button>
  );
}

export function SignOutButton() {
  return (
    <Button
      variant="ghost"
      onClick={() => authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign("/") } })}
    >
      Sign out
    </Button>
  );
}
