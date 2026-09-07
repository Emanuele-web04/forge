import { createFileRoute } from "@tanstack/react-router";

import { CloudAuthPanel } from "~/components/auth/CloudAuthPanel";

export const Route = createFileRoute("/login")({
  component: () => <CloudAuthPanel mode="login" />,
});
