import { createFileRoute } from "@tanstack/react-router";

import { CloudAuthPanel } from "~/components/auth/CloudAuthPanel";

export const Route = createFileRoute("/signup")({
  component: () => <CloudAuthPanel mode="signup" />,
});
