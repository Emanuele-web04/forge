import { redirect } from "next/navigation";

// The domain root belongs to the marketing site; this app is only ever
// reached through the /@handle rewrite. A direct hit on its root (the bare
// Vercel deployment URL) goes home.
export default function Root() {
  redirect("https://trysynara.com");
}
