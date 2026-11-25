"use client";

import { Button } from "@monashautomation/ui/button";
import { LogOut } from "lucide-react";
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
      size="sm"
      aria-label="Sign out"
      onClick={() => authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign("/") } })}
    >
      <LogOut className="sm:hidden" aria-hidden />
      <span className="hidden sm:inline">Sign out</span>
    </Button>
  );
}
