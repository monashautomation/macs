import { headers } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { SignInButton, SignOutButton } from "@/components/auth-buttons";
import { EmptyState } from "@/components/empty-state";
import { Frame } from "@/components/macs/frame";
import { MyVms } from "@/components/macs/my-vms";
import { SignInCard } from "@/components/sign-in-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { env } from "@/env";
import { getPrincipal } from "@/lib/authz";
import { frameProps } from "@/lib/frame-props";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const e = env();
  const principal = await getPrincipal(await headers());
  const { denied } = await searchParams;

  if (!principal || principal.kind !== "user") {
    return (
      <AppShell appName={e.APP_NAME} libraryUrl={e.AUTHENTIK_LIBRARY_URL}>
        <SignInCard
          appName={e.APP_NAME}
          description="Sign in with your Monash Automation account to deploy and manage your VMs and GPU time."
          action={<SignInButton />}
        />
      </AppShell>
    );
  }
  if (!principal.roles.has("member")) {
    return (
      <AppShell appName={e.APP_NAME} libraryUrl={e.AUTHENTIK_LIBRARY_URL} user={<SignOutButton />}>
        <EmptyState
          title="No access yet"
          description="Your account doesn't have access to this app. Ask Systems & Infra if you think it should."
        />
      </AppShell>
    );
  }
  return (
    <Frame {...frameProps(principal)}>
      {denied ? (
        <Alert className="mb-6">
          <AlertTitle>Not allowed</AlertTitle>
          <AlertDescription>You don't have permission for that page.</AlertDescription>
        </Alert>
      ) : null}
      <MyVms />
    </Frame>
  );
}
