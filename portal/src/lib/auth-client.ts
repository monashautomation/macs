"use client";

import { createAuthClient } from "better-auth/react";

// Authentik (registered server-side through genericOAuth) is used like any
// social provider: authClient.signIn.social({ provider: "authentik" }).
export const authClient = createAuthClient();
