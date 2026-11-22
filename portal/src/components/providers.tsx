"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";

type Ask = { title: string; description?: ReactNode; confirm?: string; destructive?: boolean };
const ConfirmContext = createContext<(ask: Ask) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({ title: "Delete?" })) …` */
export const useConfirm = () => useContext(ConfirmContext);

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  const [pending, setPending] = useState<(Ask & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (ask: Ask) => new Promise<boolean>((resolve) => setPending({ ...ask, resolve })),
    [],
  );
  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <QueryClientProvider client={client}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <AlertDialog open={!!pending} onOpenChange={(open) => !open && answer(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
              {pending?.description ? (
                <AlertDialogDescription>{pending.description}</AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => answer(false)}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={pending?.destructive ? buttonVariants({ variant: "destructive" }) : undefined}
                onClick={() => answer(true)}
              >
                {pending?.confirm ?? "Continue"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ConfirmContext.Provider>
    </QueryClientProvider>
  );
}
