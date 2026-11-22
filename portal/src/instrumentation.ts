/** Next.js calls this once when the server process starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { boot } = await import("@/server/boot");
  await boot();
}
